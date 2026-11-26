"""Summarize paired browser rounds from the merged Jco branch and its upstream base."""
import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import json
from pathlib import Path
from statistics import median

bench = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument("input", type=Path, nargs="?", default=bench / "results/review-matrix.json.gz")
parser.add_argument("--plot", type=Path)
args = parser.parse_args()
with gzip.open(args.input) as source:
    result = json.load(source)
assert result["inventorySha256"] == hashlib.sha256((bench / "results/candidate-sizes.json").read_bytes()).hexdigest()
runner_hash = hashlib.sha256((bench / "review-matrix.mjs").read_bytes()).hexdigest()
if "minify" not in result:
    # Original eight-round archives predate the minification switch.
    assert result["runnerSha256"] == "9b76e7f77a7653cf5ada4b8d114ce9572a0e34796f8ecd904820a0299474289f"
else:
    assert result["runnerSha256"] == runner_hash
if result.get("minify"):
    inventory = (bench / "results/minified-sizes.json").read_bytes()
    assert result["minifiedInventorySha256"] == hashlib.sha256(inventory).hexdigest()
    components = json.loads(inventory)["components"]
    for row in result["samples"]:
        if row["version"] == "release":
            entry = Path(row["entry"])
            guest = f"{row['lang']}/{row['demo']}/native/{entry.stem}.wasm"
            for asset in components[guest]["baseline-minified"]:
                key = str(entry.with_name(Path(asset["path"]).name))
                assert result["manifest"][key]["sha256"] == asset["sha256"]
focus = {
    "attribute-churn": ("per setAttribute()", "Attribute write"),
    "canvas-draw": ("per fill_rect()", "Canvas fillRect"),
    "canvas-pixels": ("getImageData(): µs/call", "Canvas pixel read"),
    "dom-query": ("individual: µs/element", "DOM ID lookup"),
    "dom-traversal": ("traverse (total)", "Tree traversal"),
    "string-marshalling": ("get 1024 B", "Read 1 KiB string"),
    "table-update": ("create: total ms", "Table creation"),
}
assert focus.keys() == result["workloads"].keys()
rounds = result["rounds"]
languages = {"c": "C", "cpp": "C++", "rust": "Rust"}
versions = ["release", "main", "bundled", "external"]
samples = defaultdict(dict)
positions = defaultdict(list)
for row in result["samples"]:
    key = row["demo"], row["lang"], row["version"]
    r = row["round"]
    assert r not in samples[key] and row["firstResultMs"] > row["loadMs"] > 0
    assert row["cold"].keys() == row["warm"].keys() and focus[row["demo"]][0] in row["warm"]
    samples[key][r] = row
    if row["kind"] == "jco":
        positions[key[:2], r].append((row["position"], row["version"]))
assert all(set(rows) == set(range(rounds)) for rows in samples.values())
for demo in focus:
    for lang in languages:
        counts = Counter()
        for r in range(rounds):
            block = sorted(positions[(demo, lang), r])
            assert len(block) == 4 and block[-1][0] == block[0][0] + 3
            counts.update((index, version) for index, (_, version) in enumerate(block))
        assert len(counts) == 16 and set(counts.values()) == {rounds // 4}

def paired(rows, base, value):
    return median(value(row) / value(base[r]) for r, row in rows.items())

stats = defaultdict(list)
plotted = defaultdict(list)
print("| Operation | Guest | Bundled / shim | External / shim | Bundled / 1.13 warm | External / 1.13 warm | Bundled / 1.13 first result | External / 1.13 first result |")
print("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |")
for demo, (metric, title) in focus.items():
    for lang, label in languages.items():
        def warm(row):
            return row["warm"][metric]
        def first(row):
            return row["firstResultMs"]
        builds = {v: samples[demo, lang, v] for v in versions}
        shims = [(language, rows) for (d, language, v), rows in samples.items() if d == demo and v not in versions]
        best = min(median(map(warm, rows.values())) for _, rows in shims)
        matched = [median(map(warm, rows.values())) for language, rows in shims if language == lang]
        cells = []
        for key in ("shim", "warm", "first"):
            for v in versions[2:]:
                rows = builds[v]
                ratio = median(map(warm, rows.values())) / best if key == "shim" else paired(rows, builds["release"], warm if key == "warm" else first)
                cells.append(f"{ratio:.2f}×")
                stats[v, key].append(ratio)
                plotted[v, key, lang].append(ratio)
        print("|", " | ".join([title, label, *cells]), "|")
        for v, rows in builds.items():
            stats[v, "importMs"].append(median(row["loadMs"] for row in rows.values()))
            stats[v, "firstMs"].append(median(map(first, rows.values())))
            stats[v, "entryKiB"].append(result["manifest"][next(iter(rows.values()))["entry"]]["bytes"] / 1024)
            stats[v, "jsKiB"].append(median(sum(q["bytes"] for q in row["requests"] if q["path"].endswith(".js")) / 1024 for row in rows.values()))
            stats[v, "jsRequests"].append(median(sum(q["path"].endswith(".js") for q in row["requests"]) for row in rows.values()))
            if result.get("minify"):
                stats[v, "gzipKiB"].append(median(
                    sum(result["manifest"][q["path"]]["gzip"] for q in row["requests"] if q["path"].endswith(".js")) / 1024
                    for row in rows.values()
                ))
            if matched:
                stats[v, "sameLanguageShim"].append(median(map(warm, rows.values())) / min(matched))
            if v in versions[2:]:
                stats[v, "vsMain"].append(paired(rows, builds["main"], warm))
                for name, metric_value in (("warm", warm), ("first", first)):
                    ratios = [metric_value(row) / metric_value(builds["release"][r]) for r, row in rows.items()]
                    stats[v, name + "EveryRoundSlower"].append(min(ratios) > 1)
                for phase in next(iter(rows.values()))["warm"]:
                    available = [median(row["warm"][phase] for row in s.values()) for _, s in shims if phase in next(iter(s.values()))["warm"]]
                    if available:
                        stats[v, "phaseShim"].append(median(row["warm"][phase] for row in rows.values()) / min(available))

print("\n", len(result["samples"]), "documents;", rounds, "rounds")
for v in versions:
    print(v, "median import, first result (ms), entry, total JS (KiB), JS requests:", *(round(median(stats[v, k]), 2) for k in ("importMs", "firstMs", "entryKiB", "jsKiB", "jsRequests")))
    if result.get("minify"):
        print("Median sum of gzip JS asset sizes (KiB):", round(median(stats[v, "gzipKiB"]), 2))
    if v in versions[2:]:
        print("Slower than release every round (warm, first result):", *(sum(stats[v, k + "EveryRoundSlower"]) for k in ("warm", "first")))
        for k in ("shim", "sameLanguageShim", "phaseShim", "warm", "first", "vsMain"):
            x = stats[v, k]
            threshold = 10 if "shim" in k.lower() else 1
            print(k, sum(y <= threshold for y in x), "/", len(x), "maximum", round(max(x), 3))
if args.plot:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(1, 3, figsize=(11.3, 4.8), sharey=True, layout="constrained")
    for ax, key, label in zip(axes, ("shim", "warm", "first"), ("Warm / fastest shim", "Warm / Jco 1.13", "First result / Jco 1.13")):
        for i, lang in enumerate(languages):
            y = [j + (i - 1) * .21 for j in range(len(focus))]
            for v, marker, color in [("bundled", "o", "#00796B"), ("external", "x", "#AD4524")]:
                ax.scatter(plotted[v, key, lang], y, s=24, marker=marker, color=color, label=v.capitalize() if i == 0 else None)
        ax.set_xscale("log", base=2)
        ax.axvline(1, lw=1, color="#555")
        if key == "shim":
            ax.axvline(10, ls="--", color="#555", lw=1, label="10× target")
        ax.set_title(label, fontsize=11)
        ticks = [.25, .5, 1, 2, 4, 8, 10] if key == "shim" else [.25, .5, 1, 2, 4]
        ax.set_xticks(ticks, [f"{n:g}×" for n in ticks], fontsize=8)
        ax.grid(axis="x", alpha=.18)
    axes[0].set_yticks(range(len(focus)), [s[1] for s in focus.values()])
    axes[0].invert_yaxis()
    fig.legend(*axes[0].get_legend_handles_labels(), loc="outside lower center", ncol=3)
    fig.savefig(args.plot, dpi=160)
