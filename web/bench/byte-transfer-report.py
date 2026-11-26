"""Summarize byte-list copies and paired C canvas readbacks."""
import argparse
import gzip
import json
from math import comb
from pathlib import Path
from statistics import median

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--results", type=Path, default=Path(__file__).parent / "results")
parser.add_argument("--plot", type=Path)
args = parser.parse_args()
def load(name):
    with gzip.open(args.results / f"list-allocation-{name}.json.gz", "rt") as source:
        return json.load(source)

def interval(values):
    """Distribution-free, two-sided interval with at least 95% coverage for a median."""
    v = sorted(values)
    n = len(v)
    trim = max(i for i in range(n // 2) if 2 * sum(comb(n, j) for j in range(i + 1)) / 2**n <= 0.05)
    return v[trim], median(v), v[-trim - 1]

def ratios(a, b):
    assert len(a) == len(b)
    return interval([x/y for x, y in zip(a, b)])

run = load("transfer")
modes = ["direct", "release", "main", "previous-bundled", "bundled", "previous-external", "external"]
lengths = [16, 256, 4096, 123904]
data = {(r["length"], r["mode"], r["round"], r["pass"]): r["elapsedMs"] * 1e6 / r["count"] for r in run["samples"]}
assert len(run["samples"]) == len(data) == 12 * 5 * len(modes) * len(lengths)
series = {m: [] for m in ["bundled", "external"]}
print("| Result bytes | Direct Wasm | 1.13.0 | Main | Bundled before | Bundled after | External before | External after |")
print("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
for n in lengths:
    pages = {m: [median(data[n,m,r,p] for p in range(5)) for r in range(12)] for m in modes}
    print(f"| {n:,} | " + " | ".join(f"{median(pages[m]):,.0f}" for m in modes) + " |")
    for mode in series:
        series[mode].append(ratios(pages[mode], pages["previous-" + mode]))

print("\n| C canvas readback | Rounds | After / before | 95% interval | Duplicate / before |")
print("| --- | ---: | ---: | --- | ---: |")
for study, host, label in [("canvas", "original", "Original host, 10 ms"),
                          ("canvas", "view", "Pixel-view host, 10 ms"),
                          ("isolated", "original", "Original host, isolated pages, 10 ms"),
                          ("short-control", "original", "Original host, duplicate control, 10 ms"),
                          ("observed", "original", "Original host, timed host method, 50 ms"),
                          ("long", "original", "Original host, 50 ms")]:
    sample = load(study)
    assert sample["candidate"]["generatorSha256"] == run["generatorSha256"]
    assert sample["candidate"]["previousGeneratorSha256"] == run["previousGeneratorSha256"]
    rows = [r for r in sample["samples"] if r["host"] == host]
    assert all(r["pixelsChecked"] == 2 * sample["size"]**2 for r in rows)
    modes_present = set(r["version"] for r in rows)
    def values(mode, metric):
        def get(row):
            return row["readUs"] if metric == "readUs" else row["readback"][metric]
        times = {(r["round"], r["pass"]): get(r) for r in rows if r["version"] == mode}
        assert len(times) == sample["passes"] * sample["rounds"]
        return [median(times[r,p] for p in range(1, sample["passes"]+1)) for r in range(1, sample["rounds"]+1)]
    metrics = ["readUs", "hostUs", "remainderUs"] if study == "observed" else ["readUs"]
    for metric in metrics:
        before = values("before", metric)
        low, mid, high = ratios(values("after", metric), before)
        control = f'{ratios(values("control", metric), before)[1]:.2f}×' if "control" in modes_present else "—"
        row_label = {"readUs": label, "hostUs": "↳ Inside host read", "remainderUs": "↳ Outside host read"}[metric]
        print(f"| {row_label} | {len(before)} | {mid:.2f}× | {low:.2f}–{high:.2f}× | {control} |")

if args.plot:
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(7.8, 3.5), layout="constrained")
    for mode, shift, color in [("bundled", -0.08, "#19766d"), ("external", 0.08, "#934785")]:
        low, mid, high = zip(*series[mode])
        ax.errorbar([i+shift for i in range(len(lengths))], mid,
                    yerr=[[m-l for l,m in zip(low,mid)], [h-m for m,h in zip(mid,high)]],
                    fmt="o", capsize=4, color=color, label=mode.capitalize())
    ax.axhline(1, linestyle="--", color="#555", linewidth=1)
    ax.set_xticks(range(len(lengths)), ["16 B","256 B","4 KiB","121 KiB"])
    ax.set_xlabel("Host-to-guest byte-list size")
    ax.set_ylabel("Time / previous PR head")
    ax.set_title("Checked list copies in Chromium", fontweight="bold")
    ax.spines[["right","top"]].set_visible(False)
    ax.yaxis.grid(True, alpha=0.18)
    fig.legend(loc="outside lower center", ncol=2, frameon=False)
    fig.savefig(args.plot, dpi=145)
