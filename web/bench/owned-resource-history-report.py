"""Check owned-resource disposal and summarize time per synchronous guest call."""
import argparse
from collections import Counter
import gzip
import hashlib
import json
from pathlib import Path
from statistics import median

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("samples", type=Path)
parser.add_argument("--plot", type=Path)
args = parser.parse_args()
with gzip.open(args.samples) as stream:
    run = json.load(stream)
runner = Path(__file__).with_name("owned-resource-history.mjs")
assert hashlib.sha256(runner.read_bytes()).hexdigest() == run["runner"]
assert run["release"] == "1.13.0"
modes = {"release", "before-bundled", "after-bundled", "before-external", "after-external"}
assert set(run["entries"]) == modes
counts = [0, 8192, 32768, 131072]
retained = {}
for row in run["retention"]:
    mode, calls = row["mode"], row["calls"]
    assert row["drops"] == calls
    assert row["numericSets"] == ([calls] if calls and mode.startswith("before") else [])
    retained[mode, calls] = sum(row["numericSets"])
assert len(run["retention"]) == len(retained) == len(modes) * len(counts)
assert set(retained) == {(mode, count) for mode in modes for count in counts}

rounds, passes = range(20), range(3)
samples = run["timings"]
times = {(r["round"], r["pass"], r["mode"]): r["nsPerCall"] for r in samples}
assert len(times) == len(samples) == len(rounds) * len(passes) * len(modes)
assert all(t > 0 for t in times.values())
for p in passes:
    positions, predecessors = Counter(), Counter()
    for r in rounds:
        group = sorted((s for s in samples if s["round"] == r and s["pass"] == p),
                       key=lambda s: s["position"])
        order = [s["mode"] for s in group]
        assert set(order) == modes and [s["position"] for s in group] == list(range(len(modes)))
        positions.update(enumerate(order))
        predecessors.update(zip(order, order[1:]))
    assert len(positions) == 25 and len(predecessors) == 20
    assert set(positions.values()) == set(predecessors.values()) == {4}

for mode in sorted(modes):
    page_medians = [median(times[r, p, mode] for p in passes) for r in rounds]
    print(f"{mode}: {retained[mode, counts[-1]]:,} entries after {counts[-1]:,} drops,"
          f" {median(page_medians) / 1000:.3f} µs/call")
for mode in ["bundled", "external"]:
    ratios = sorted(median(times[r, p, "after-" + mode] / times[r, p, "before-" + mode]
                           for p in passes) for r in rounds)
    # For 20 paired documents, ranks 6 and 15 give a two-sided 95.86% sign interval.
    print(f"{mode} after/before: {median(ratios):.3f} ({ratios[5]:.3f}–{ratios[-6]:.3f})")

if args.plot:
    import matplotlib.pyplot as plt
    from matplotlib.ticker import StrMethodFormatter

    fig, axes = plt.subplots(1, 2, figsize=(8.5, 3.2), layout="constrained", sharey=True)
    for ax, mode, title in zip(axes, ["bundled", "external"], ["Internal Oxc", "External checked"]):
        for revision, label, color in [("before", "Before", "#ab542b"), ("after", "After", "#21716e")]:
            ax.plot(counts, [retained[revision + "-" + mode, n] for n in counts],
                    color=color, marker="o", label=label)
        ax.set(title=title, xlabel="Resources dropped", xticks=[0, 32768, 131072])
        ax.xaxis.set_major_formatter(StrMethodFormatter("{x:,.0f}"))
        ax.yaxis.set_major_formatter(StrMethodFormatter("{x:,.0f}"))
        ax.grid(axis="y", alpha=0.25)
        ax.legend(frameon=False)
    axes[0].set_ylabel("Numeric IDs retained after GC")
    fig.savefig(args.plot, dpi=150)
