"""Compare construction of precompiled cores in the public async instantiation API."""
import argparse
from collections import Counter
import gzip
from hashlib import sha256
import json
from math import comb, isclose
from pathlib import Path
from statistics import median

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("archive", type=Path)
parser.add_argument("matrix", type=Path)
parser.add_argument("--trace", type=Path, help="separate first-instance callback trace")
parser.add_argument("--plot", type=Path, help="plot the first-instance trace")
args = parser.parse_args()
if args.plot and not args.trace:
    parser.error("--plot requires --trace")
study = json.loads(gzip.decompress(args.archive.read_bytes()))
matrix = json.loads(gzip.decompress(args.matrix.read_bytes()))
assert study["runner"] == sha256(Path(__file__).with_name("precompiled-instances.mjs").read_bytes()).hexdigest()
assert study["matrix"] == sha256(args.matrix.read_bytes()).hexdigest()
assert study["revision"] == matrix["candidate"] and study["chromium"] == matrix["chromium"]
rounds = study["rounds"]
assert rounds == 12 and study["batchSize"] == 8
builds = ["release", "bundled", "external"]
strategies = ["default", "async", "small", "sync"]
languages = ["c", "cpp", "rust"]
rows = {(r["lang"], r["build"], r["strategy"], r["round"]): r for r in study["samples"]}
assert len(rows) == len(study["samples"]) == rounds * 3 * 3 * 4
for lang in languages:
    all_orders = []
    for build in builds:
        files = study["files"][f"/{lang}/{build}/"]
        assert files == study["files"][f"/{lang}/release/"]
        assert files["table_update.core.wasm"]["sha256"] == matrix["manifest"][f"/{lang}/table-update/{build}/table_update.core.wasm"]["sha256"]
        for strategy in strategies:
            positions = []
            for rnd in range(rounds):
                row = rows[lang, build, strategy, rnd]
                assert len(row["batches"]) == 6 and min(row["batches"]) > 0
                assert row["firstMs"] > 0
                order = [c["name"] for c in row["calls"]]
                assert len(order) == len(files) and set(order) == set(files)
                all_orders.append(order)
                positions.append(row["pos"])
            assert sorted(positions) == list(range(rounds))
    assert all(o == all_orders[0] for o in all_orders)
    adjacencies = Counter()
    for rnd in range(rounds):
        order = sorted((rows[lang, b, s, rnd]["pos"], b, s) for b in builds for s in strategies)
        adjacencies.update((a[1:], b[1:]) for a, b in zip(order, order[1:]))
    assert len(adjacencies) == rounds * (rounds - 1) and set(adjacencies.values()) == {1}

def interval(values):
    # Distribution-free, two-sided interval for the population median.
    data = sorted(values)
    k = max(i for i in range(len(data)//2) if 2*sum(comb(len(data), j) for j in range(i)) <= .05 * 2**len(data))
    return f"{median(data):.3f} ({data[k]:.3f}–{data[-1-k]:.3f})"

def value(row, phase):
    return row["firstMs"] if phase == "first" else median(row["batches"][1:])

for phase in ("first", "repeated"):
    print(phase, "instantiation, time excludes module import, compilation and benchmark guest call")
    for lang in languages:
        for build in builds:
            fields = []
            for left, right in [("async", "default"), ("small", "async"), ("sync", "async")]:
                fields.append(interval(value(rows[lang,build,left,r], phase) / value(rows[lang,build,right,r], phase) for r in range(rounds)))
            typical = median(value(rows[lang,build,"default",r], phase) for r in range(rounds))
            print(lang, build, f"{typical:.3f} ms", *fields)
    for build in builds:
        def typical(r, strategy):
            return median(value(rows[lang,build,strategy,r], phase) for lang in languages)
        print("suite", build, "default ms", f"{median(typical(r, 'default') for r in range(rounds)):.3f}")
        for left, right in [("small", "async"), ("sync", "async"), ("small", "default")]:
            ratios = [median(value(rows[lang,build,left,r], phase) / value(rows[lang,build,right,r], phase)
                             for lang in languages) for r in range(rounds)]
            print("suite",build,left,"/",right,interval(ratios))
for lang in languages:
    print("core bytes",lang, [m["bytes"] for m in study["files"][f"/{lang}/release/"].values()])


if args.trace:
    trace = json.loads(gzip.decompress(args.trace.read_bytes()))
    for key in ("runner", "matrix", "revision", "chromium", "guests", "manifest", "files", "rounds"):
        assert trace[key] == study[key], key
    assert trace["traced"] and not study["traced"]
    assert len(trace["samples"]) == rounds * 3 * 3
    records = {}
    for sample in trace["samples"]:
        lang, build, rnd = (sample[k] for k in ("lang", "build", "round"))
        assert (lang, build, rnd) not in records and sample["strategy"] == "traced"
        events = sample["events"]
        files = trace["files"][f"/{lang}/{build}/"]
        assert all(0 <= e["time"] <= sample["firstMs"] for e in events)
        assert [e["time"] for e in events] == sorted(e["time"] for e in events)
        for action in ("lookup", "start", "end"):
            assert sorted(e["name"] for e in events if e["action"] == action) == sorted(files)
        calls = [e for e in events if e["action"] != "lookup"]
        pairs = list(zip(calls[::2], calls[1::2], strict=True))
        assert all(a["action"] == "start" and b["action"] == "end" and a["name"] == b["name"] for a, b in pairs)
        durations = {a["name"]: b["time"] - a["time"] for a, b in pairs}
        main = durations.pop("table_update.core.wasm")
        first_lookup = events[0]
        assert first_lookup["action"] == "lookup"
        parts = {"before lookup": first_lookup["time"], "lookup to first constructor": calls[0]["time"] - first_lookup["time"],
                 "guest constructor": main, "adapter constructors": sum(durations.values()),
                 "between constructors": sum(b[0]["time"] - a[1]["time"] for a, b in zip(pairs, pairs[1:])),
                 "after last constructor": sample["firstMs"] - calls[-1]["time"]}
        assert min(parts.values()) >= 0 and isclose(sum(parts.values()), sample["firstMs"], abs_tol=1e-7)
        records[lang, build, rnd] = (sample["pos"], parts)
    for lang in languages:
        for build in builds:
            assert Counter(records[lang,build,r][0] for r in range(rounds)) == {0: 4, 1: 4, 2: 4}
    for build in builds:
        print("traced first",build)
        for key in parts:
            def observations(mode):
                return [median(records[l,mode,r][1][key] for l in languages) for r in range(rounds)]
            contribution = [median(records[l,build,r][1][key] - records[l,"release",r][1][key] for l in languages)
                            for r in range(rounds)]
            print(key, "ms", interval(observations(build)), "paired additional ms vs release",interval(contribution))

    if args.plot:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from matplotlib.ticker import MultipleLocator
        groups = [
            ("Before first core lookup", ["before lookup"], "#265c88"),
            ("Lookup to first constructor", ["lookup to first constructor"], "#41a7a0"),
            ("Inside Wasm constructors", ["guest constructor", "adapter constructors"], "#e4ac57"),
            ("Between constructors", ["between constructors"], "#9aa6af"),
            ("After last constructor", ["after last constructor"], "#81558d"),
        ]
        fig, ax = plt.subplots(figsize=(9, 3.6), layout="constrained")
        for y, build in enumerate(builds):
            left = 0
            for label, keys, color in groups:
                # Give each language and browser process equal weight. Means
                # preserve the additivity of the measured timing boundaries.
                duration = sum(sum(records[l,build,r][1][k] for k in keys)
                               for l in languages for r in range(rounds)) / (len(languages) * rounds)
                ax.barh(y, duration, left=left, height=.58, color=color, label=label if y == 0 else None)
                left += duration
            ax.text(left+.075, y, f"{left:.2f} ms", va="center")
        ax.set_yticks(range(3), ["Jco 1.13.0", "Internal Oxc", "External runtime"])
        ax.invert_yaxis()
        ax.xaxis.set_major_locator(MultipleLocator(1))
        ax.margins(x=.17)
        ax.set_xlabel("Mean time with bindings imported and Wasm compiled (ms)")
        ax.set_title("First table instance across C, C++ and Rust", loc="left")
        ax.legend(loc="upper center", bbox_to_anchor=(.5,-.31), ncols=3, frameon=False, fontsize=9)
        ax.spines[["top", "right", "left"]].set_visible(False)
        fig.savefig(args.plot, dpi=160)
