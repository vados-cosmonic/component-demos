"""Compare same-page export timings as more host calls share one guest entry."""
import argparse
from collections import defaultdict
import gzip
import hashlib
import json
from math import comb
from pathlib import Path
from statistics import median

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("archive")
parser.add_argument("--plot")
args = parser.parse_args()
with gzip.open(args.archive) as source:
    data = json.load(source)

rounds, sizes, modes = data["rounds"], data["sizes"], data["modes"]
assert data["runnerSha256"] == hashlib.sha256(Path(__file__).with_name("export-host-batch.mjs").read_bytes()).hexdigest()
assert data["compilerHashes"]["before"] != data["compilerHashes"]["after"]
assert data["manifest"]["/before-external/batch.js"] == data["manifest"]["/after-external/batch.js"]
assert modes == ["direct", "release", "before-internal", "after-internal", "before-external", "after-external"]
passes = range(len(modes), 2 * len(modes))
rows = defaultdict(dict)
for row in data["samples"]:
    group = rows[row["round"], row["batch"], row["mode"]]
    assert row["pass"] not in group and row["ns"] > 0
    group[row["pass"]] = row

assert len(rows) == rounds * len(sizes) * len(modes)
for group in rows.values():
    assert set(group) == set(passes)
    assert {s["position"] for s in group.values()} == set(range(len(modes)))

rank = max(i for i in range(rounds)
           if 2 * sum(comb(rounds, k) for k in range(i+1)) / 2**rounds <= .05)


def page_time(batch, mode):
    return median(median(s["ns"] for s in rows[r, batch, mode].values()) for r in range(rounds))


def interval(batch, mode, baseline):
    # Each page contributes one observation. Within it, the numerator and
    # denominator use the same pass and exactly the same number of guest calls.
    ratios = sorted(median(rows[r, batch, mode][p]["ns"] / rows[r, batch, baseline][p]["ns"]
                           for p in passes) for r in range(rounds))
    return median(ratios), ratios[rank], ratios[-1-rank]


print("| Host calls per guest entry | Direct Wasm (ns) | Jco 1.13.0 (ns) | Internal before (ns) | Internal after (ns) | External before (ns) | External after (ns) |")
print("|" + " ---: |" * 7)
for batch in sizes:
    print("|", batch, "|", " | ".join(f"{page_time(batch, m):,.1f}" for m in modes), "|")

comparisons = [("after-internal", "direct"), ("after-external", "direct"),
               ("after-internal", "release"), ("after-external", "release"),
               ("after-internal", "before-internal"), ("after-external", "before-external")]
print("\n| Host calls | Internal / direct | External / direct | Internal / 1.13 | External / 1.13 | Internal after / before | External after / before |")
print("|" + " ---: |" * 7)
for batch in sizes:
    cells = []
    for mode, baseline in comparisons:
        mid, low, high = interval(batch, mode, baseline)
        cells.append(f"{mid:.3f}× ({low:.3f}–{high:.3f})")
    print("|", batch, "|", " | ".join(cells), "|")

if args.plot:
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(1, 2, figsize=(9, 3.8), layout="constrained")
    for ax, ref, label in zip(axes, ["direct", "release"], ["direct Wasm", "Jco 1.13.0"]):
        for mode, color, marker in [("internal", "#00796b", "o"), ("external", "#ad4524", "x")]:
            mid, low, high = zip(*(interval(n, "after-" + mode, ref) for n in sizes))
            ax.plot(sizes, mid, color=color, marker=marker, label=mode.capitalize())
            ax.fill_between(sizes, low, high, color=color, alpha=.13)
        ax.set(xscale="log", yscale="log", xlabel="Host calls per guest entry", title=f"Time / {label}")
        ax.axhline(1, color="#555", linewidth=1)
        if ref == "direct":
            ax.axhline(10, color="#555", linestyle="--", linewidth=1, label="10× target")
        ax.set_xticks(sizes, [str(n) for n in sizes])
        ticks = [1, 2, 5, 10, 20, 40]
        ax.set_yticks(ticks, [f"{y}×" for y in ticks])
        ax.set_ylim(.9, 42)
        ax.grid(alpha=.16)
    axes[0].legend(fontsize=8)
    fig.savefig(args.plot, dpi=160)
