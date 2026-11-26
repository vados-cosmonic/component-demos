"""Summarize paired browser rounds from the merged Jco branch and its upstream base."""
import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import json
from math import comb
from pathlib import Path
from statistics import median

bench = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument("input", type=Path, nargs="?", default=bench / "results/review-matrix.json.gz")
parser.add_argument("--plot", type=Path)
parser.add_argument("--release-intervals", action="store_true",
                    help="show individual paired median intervals against Jco 1.13.0")
args = parser.parse_args()
with gzip.open(args.input) as source:
    result = json.load(source)
assert result["inventorySha256"] == hashlib.sha256((bench / "results/candidate-sizes.json").read_bytes()).hexdigest()
runner_hash = hashlib.sha256((bench / "review-matrix.mjs").read_bytes()).hexdigest()
if "minify" not in result:
    # Original eight-round archives predate the minification switch.
    assert result["runnerSha256"] == "9b76e7f77a7653cf5ada4b8d114ce9572a0e34796f8ecd904820a0299474289f"
elif result["runnerSha256"] == "b9e3afa3b4354a6544ebb8ea5d593f7d3ed193706585e6a2db1a103ec6d977de":
    assert "checkedPackage" not in result
elif result["runnerSha256"] == "cf7384f34b03e4389275108649c7dbbaa719ab94cbcfd91e48fbad5105e49789":
    # Benchmark commit f2d27b2 supplied ROUNDS=10 explicitly.
    assert result["checkedPackage"] and result["rounds"] == 10
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
has_previous = "previous" in result["compilers"]
timed_versions = versions + (["previous"] if has_previous else [])
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
            assert len(block) == len(timed_versions) and block[-1][0] == block[0][0] + len(block) - 1
            counts.update((index, version) for index, (_, version) in enumerate(block))
        assert len(counts) == len(timed_versions)**2 and set(counts.values()) == {rounds // len(timed_versions)}

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
        shims = [(language, rows) for (d, language, v), rows in samples.items() if d == demo and v not in timed_versions]
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
if args.release_intervals or has_previous:
    # Order-statistic bounds for a two-sided sign test, with at least 95%
    # individual coverage. Pairs share one timing round within each case.
    if rounds < 6:
        parser.error("median intervals require at least six paired rounds")
    rank = max(i for i in range(rounds) if 2 * sum(comb(rounds,j) for j in range(i+1)) / 2**rounds <= .05)

    def median_interval(ratios):
        ordered = sorted(ratios)
        return median(ordered), ordered[rank], ordered[-rank-1]

if args.release_intervals:
    print("\n| Guest and operation | Internal warm / release | External warm / release | Internal first / release | External first / release |")
    print("| --- | ---: | ---: | ---: | ---: |")
    counts = defaultdict(Counter)
    for demo, (metric, title) in focus.items():
        for lang, label in languages.items():
            base = samples[demo,lang,"release"]
            fields = []
            for phase, get in (("warm", lambda row: row["warm"][metric]), ("first", lambda row: row["firstResultMs"])):
                for version in ("bundled", "external"):
                    current = samples[demo,lang,version]
                    mid, lo, hi = median_interval(get(current[r]) / get(base[r]) for r in range(rounds))
                    outcome = "faster" if hi < 1 else "slower" if lo > 1 else "includes parity"
                    counts[phase,version][outcome] += 1
                    fields.append(f"{mid:.3f}× ({lo:.3f}–{hi:.3f})")
            print("|", label, title, "|", " | ".join(fields), "|")
    print("\n| Phase and build | Entirely faster | Includes parity | Entirely slower |")
    print("| --- | ---: | ---: | ---: |")
    for (phase,version), counter in counts.items():
        print(f"| {phase} {version} | {counter['faster']} | {counter['includes parity']} | {counter['slower']} |")

if has_previous:
    assert result["checkedPackage"] == "@bytecodealliance/jco-cm-runtime"
    changes = defaultdict(list)
    print("\n| Guest and operation | Entry bytes saved | Gzip bytes saved | Paired import | Paired first result | Paired warm operation |")
    print("| --- | ---: | ---: | ---: | ---: | ---: |")
    for demo, (metric, title) in focus.items():
        for lang, label in languages.items():
            current = samples[demo,lang,"external"]
            previous = samples[demo,lang,"previous"]
            old = result["manifest"][previous[0]["entry"]]
            new = result["manifest"][current[0]["entry"]]
            sizes = [old[k] - new[k] for k in ("bytes","gzip")]
            assert all(size > 0 for size in sizes)
            for key, size in zip(("size","gzip"), sizes):
                changes[key].append(size)
            predecessors = Counter()
            for r in range(rounds):
                order = [v for _,v in sorted(positions[(demo,lang),r])]
                predecessors.update(zip(order, order[1:]))
                def requests(row):
                    return {q["path"].replace("/previous/","/external/"): q["bytes"]
                            for q in row["requests"] if q["path"] != row["entry"]}
                assert requests(current[r]) == requests(previous[r])
            assert len(predecessors) == 20 and set(predecessors.values()) == {rounds // 5}
            fields = []
            for key, get in (("import", lambda row: row["loadMs"]), ("first", lambda row: row["firstResultMs"]),
                             ("warm", lambda row: row["warm"][metric])):
                mid, lo, hi = median_interval(get(current[r])/get(previous[r]) for r in range(rounds))
                changes[key].append(mid)
                changes[key+"Faster"].append(hi < 1)
                changes[key+"Slower"].append(lo > 1)
                fields.append(f"{mid:.2f}× ({lo:.2f}–{hi:.2f})")
            print("|", label, title, "|", *[str(s)+" |" for s in sizes], " | ".join(fields), "|")
    for key in ("size","gzip","import","first","warm"):
        print(key, "min / median / max", *(round(fn(changes[key]),4) for fn in (min,median,max)))
        if key in ("import","first","warm"):
            print("Intervals entirely faster / slower:", sum(changes[key+"Faster"]),sum(changes[key+"Slower"]))

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
