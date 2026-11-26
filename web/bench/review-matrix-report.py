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
parser.add_argument("--compare-entries", type=Path,
                    help="verify previous assets and compare generated JS sizes with an earlier matrix")
parser.add_argument("--release-intervals", action="store_true",
                    help="show individual paired median intervals against Jco 1.13.0")
parser.add_argument("--repeat-of", type=Path,
                    help="compare release intervals with an earlier run of the exact same builds and workloads")
args = parser.parse_args()
with gzip.open(args.input) as source:
    result = json.load(source)
assert result["inventorySha256"] == hashlib.sha256((bench / "results/candidate-sizes.json").read_bytes()).hexdigest()
separate_runtime = any(k.startswith("/previous-runtime/") for k in result["manifest"])
if args.compare_entries:
    with gzip.open(args.compare_entries) as source:
        previous = json.load(source)
    # A previous matrix can carry its own paired compiler controls. Compare
    # the new run with the entries that were current in that matrix.
    old = {k: v for k, v in previous["manifest"].items() if "/previous-" not in k}
    new = {k: v for k, v in result["manifest"].items() if "/previous-" not in k}
    if result.get("compareCompilers"):
        assert result["compilers"]["previous"] == previous["compilers"]["bundled"]
        for path, asset in result["manifest"].items():
            if "/previous-" in path:
                assert old[path.replace("/previous-", "/")] == asset, path
    # A comparison can now serve each external compiler with its own runtime.
    # Verify the entire previous package before comparing the compiler outputs.
    if separate_runtime:
        assert result["upstream"] == previous["upstream"]
        assert result["compilers"]["main"] == previous["compilers"]["main"]
        prior_runtime = {k.replace("/previous-runtime/", "/runtime/"): v
                         for k, v in result["manifest"].items() if k.startswith("/previous-runtime/")}
        assert prior_runtime == {k: v for k, v in old.items() if k.startswith("/runtime/")}
        old = {k: v for k, v in old.items() if not k.startswith("/runtime/")}
        new = {k: v for k, v in new.items() if not k.startswith("/runtime/")}
    assert old.keys() == new.keys()
    entries = {s["entry"]: s["version"] for s in result["samples"] if s["version"] in ("bundled", "external")}
    for path in new.keys() - entries.keys():
        assert old[path] == new[path], path
    for version in ("bundled", "external"):
        paths = [p for p, v in entries.items() if v == version]
        assert len(paths) == 21
        for metric in ("bytes", "gzip"):
            saved = [old[p][metric] - new[p][metric] for p in paths]
            print(version, metric, "entries smaller", sum(n > 0 for n in saved),
                  "of", len(paths), "bytes saved (min / median / max)", min(saved), median(saved), max(saved))
    if separate_runtime:
        for version in ("bundled", "external"):
            current = {(s["lang"], s["demo"]): s for s in result["samples"]
                       if s["round"] == 0 and s["version"] == version}
            controls = {(s["lang"], s["demo"]): s for s in result["samples"]
                        if s["round"] == 0 and s["version"] == "previous-" + version}
            assert current.keys() == controls.keys()
            for metric in ("bytes", "gzip"):
                def transfer(row):
                    return sum(result["manifest"][r["path"]][metric] for r in row["requests"]
                               if r["path"].endswith(".js"))
                deltas = [transfer(controls[key]) - transfer(current[key]) for key in current]
                print(version, "complete JS", metric, "saved (min / median / max)",
                      min(deltas), median(deltas), max(deltas))
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
    assert result["runnerSha256"] in {runner_hash, "3d97f1f9f129c0e2cb208c3af2fe975cf6082343173a102152b3418ef72d4600", "07165d2b608750c3e0c01f73a1bcd2ab8c68761030fe8ff07fa8bb8a4039e297"}
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
compare_compilers = result.get("compareCompilers", False)
controls = (["previous-bundled", "previous-external"] if compare_compilers else ["previous"]) if has_previous else []
timed_versions = versions + controls
def index_samples(run):
    rounds = run["rounds"]
    samples = defaultdict(dict)
    positions = defaultdict(list)
    for row in run["samples"]:
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

    return samples, positions

samples, positions = index_samples(result)

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
def median_interval(ratios):
    # Each browser round contributes one paired observation per build and workload.
    ordered = sorted(ratios)
    n = len(ordered)
    if n < 6:
        parser.error("median intervals require at least six paired rounds")
    rank = max(i for i in range(n) if 2 * sum(comb(n, j) for j in range(i+1)) / 2**n <= .05)
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

if args.repeat_of:
    with gzip.open(args.repeat_of) as source:
        initial = json.load(source)
    # Attribute differences to a new measurement only when the guest, host,
    # generated assets, workload parameters, runner and environment all match.
    metadata = set(result) - {"rounds", "samples"}
    assert set(initial) == set(result)
    for key in metadata:
        assert initial[key] == result[key], key
    prior, _ = index_samples(initial)
    assert prior.keys() == samples.keys()
    print("\n| Workload | Build | Phase | Initial / release | Repeat / release |")
    print("| --- | --- | --- | ---: | ---: |")
    counts = defaultdict(Counter)
    first_result_deltas = defaultdict(list)
    for demo, (metric, title) in focus.items():
        for lang, label in languages.items():
            for version in ("bundled", "external"):
                for phase, value in (("warm", lambda row: row["warm"][metric]),
                                     ("first result", lambda row: row["firstResultMs"]),
                                     ("import", lambda row: row["loadMs"]),
                                     ("first call", lambda row: row["firstResultMs"] - row["loadMs"])):
                    estimates = []
                    for run in (prior, samples):
                        rows = run[demo, lang, version]
                        control = run[demo, lang, "release"]
                        estimates.append(median_interval(value(row) / value(control[r]) for r, row in rows.items()))
                    first, second = estimates
                    counts[phase, version]["initial"] += first[1] > 1
                    counts[phase, version]["repeat"] += second[1] > 1
                    counts[phase, version]["both"] += first[1] > 1 and second[1] > 1
                    if phase == "first result" and first[1] > 1 and second[1] > 1:
                        rows = samples[demo, lang, version]
                        control = samples[demo, lang, "release"]
                        total = [row["firstResultMs"] - control[r]["firstResultMs"] for r, row in rows.items()]
                        load = [row["loadMs"] - control[r]["loadMs"] for r, row in rows.items()]
                        guest = [t - l for t, l in zip(total, load, strict=True)]
                        first_result_deltas[version].append((median(total), median(load), median(guest)))
                    cells = [f"{mid:.3f}× ({lo:.3f}–{hi:.3f})" for mid, lo, hi in estimates]
                    print("|", " | ".join([label + " " + title, version, phase, *cells]), "|")
    print("\n| Phase and build | Slower in initial run | Slower in repeat | Slower in both |")
    print("| --- | ---: | ---: | ---: |")
    for (phase, version), counts_by_run in counts.items():
        print(f"| {phase} {version} | {counts_by_run['initial']} | {counts_by_run['repeat']} | {counts_by_run['both']} |")

    print("Repeat, median paired difference in ms for workloads slower to first result in both runs")
    print("| Build | Workloads | First result | Import and initialization | First guest call |")
    print("| --- | ---: | ---: | ---: | ---: |")
    for version, workload_medians in first_result_deltas.items():
        columns = [median(times) for times in zip(*workload_medians, strict=True)]
        print("|", version, "|", len(workload_medians), "|", " | ".join(f"{ms:+.2f}" for ms in columns), "|")

for control in controls:
    version = control.removeprefix("previous-") if compare_compilers else "external"
    print("Paired comparison with the previous compiler:", version)
    assert result["checkedPackage"] == "@bytecodealliance/jco-cm-runtime"
    changes = defaultdict(list)
    round_ratios = defaultdict(list)
    print("\n| Guest and operation | Entry bytes saved | Gzip bytes saved | Paired import | Paired first result | Paired warm operation |")
    print("| --- | ---: | ---: | ---: | ---: | ---: |")
    for demo, (metric, title) in focus.items():
        for lang, label in languages.items():
            current = samples[demo,lang,version]
            previous = samples[demo,lang,control]
            old = result["manifest"][previous[0]["entry"]]
            new = result["manifest"][current[0]["entry"]]
            sizes = [old[k] - new[k] for k in ("bytes","gzip")]
            if not compare_compilers:
                assert all(size > 0 for size in sizes)
            for key, size in zip(("size","gzip"), sizes):
                changes[key].append(size)
            predecessors = Counter()
            for r in range(rounds):
                order = [v for _,v in sorted(positions[(demo,lang),r])]
                predecessors.update(zip(order, order[1:]))
                def requests(row):
                    return {q["path"].replace("/" + control + "/", "/" + version + "/"): q["bytes"]
                            for q in row["requests"] if q["path"] != row["entry"]}
                prior_requests, current_requests = requests(previous[r]), requests(current[r])
                if separate_runtime and version == "external":
                    # Compare the shared guest cores, then validate each package's
                    # own dependency graph and transfer lengths on every document.
                    for row, expected_prefix in [(previous[r], "/previous-runtime/"), (current[r], "/runtime/")]:
                        package = [q for q in row["requests"] if q["path"].startswith(("/previous-runtime/", "/runtime/"))]
                        assert any(q["path"] == expected_prefix + "intrinsics/sync.js" for q in package)
                        assert all(q["path"].startswith(expected_prefix) and
                                   q["bytes"] == result["manifest"][q["path"]]["bytes"] for q in package)
                    prior_requests = {k: v for k, v in prior_requests.items() if not k.startswith("/previous-runtime/")}
                    current_requests = {k: v for k, v in current_requests.items() if not k.startswith("/runtime/")}
                assert prior_requests == current_requests
            n = len(timed_versions)
            assert len(predecessors) == n * (n - 1) and set(predecessors.values()) == {rounds // n}
            fields = []
            for key, get in (("import", lambda row: row["loadMs"]), ("first", lambda row: row["firstResultMs"]),
                             ("warm", lambda row: row["warm"][metric])):
                ratios = [get(current[r])/get(previous[r]) for r in range(rounds)]
                round_ratios[key].append(ratios)
                mid, lo, hi = median_interval(ratios)
                changes[key].append(mid)
                changes[key+"Faster"].append(hi < 1)
                changes[key+"Slower"].append(lo > 1)
                fields.append(f"{mid:.2f}× ({lo:.2f}–{hi:.2f})")
            print("|", label, title, "|", *[str(s)+" |" for s in sizes], " | ".join(fields), "|")
    for key in ("size","gzip","import","first","warm"):
        print(key, "min / median / max", *(round(fn(changes[key]),4) for fn in (min,median,max)))
        if key in ("import","first","warm"):
            print("Intervals entirely faster / slower:", sum(changes[key+"Faster"]),sum(changes[key+"Slower"]))
            if compare_compilers:
                # These workloads share a browser process in each round. Take
                # one median per process before estimating a suite-wide interval.
                across = median_interval(median(block) for block in zip(*round_ratios[key], strict=True))
                print("Median within-round ratio and 95% interval:", *(f"{x:.4f}" for x in across))

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
        ticks = [.25, .5, 1, 2, 4, 10] if key == "shim" else [.25, .5, 1, 2, 4]
        ax.set_xticks(ticks, [f"{n:g}×" for n in ticks], fontsize=8)
        ax.grid(axis="x", alpha=.18)
    axes[0].set_yticks(range(len(focus)), [s[1] for s in focus.values()])
    axes[0].invert_yaxis()
    fig.legend(*axes[0].get_legend_handles_labels(), loc="outside lower center", ncol=3)
    fig.savefig(args.plot, dpi=160)
