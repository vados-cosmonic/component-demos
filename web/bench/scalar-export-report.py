"""Summarize same-page JS-to-Wasm export timings and optionally draw the chart."""
import argparse
import json
from pathlib import Path
from statistics import median

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--results", type=Path, default=Path(__file__).parent / "results")
parser.add_argument("--plot", type=Path)
args = parser.parse_args()
fixtures = {"increment": "Scalar increment", "c-calculator": "C calculator",
            "rust-calculator": "Rust calculator", "rust-calculator-raw": "Rust raw calculator"}
modes = ["direct", "release", "main", "previous-bundled", "bundled", "previous-external", "external"]
points = []
versions = set()
print("| Export (ns/call) | Direct Wasm | Jco 1.13.0 | Main | Bundled before | Bundled after | External before | External after |")
print("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
for fixture, label in fixtures.items():
    data = json.loads((args.results / f"numeric-export-{fixture}.json").read_text())
    versions.add(tuple(data[k] for k in ("revision", "previousRevision", "release", "main", "chromium",
                                         "runnerSha256", "generatorSha256", "previousGeneratorSha256")))
    samples = {(r["round"], r["pass"], r["mode"]): r["elapsedMs"] for r in data["samples"]}
    assert len(samples) == len(data["samples"]) == 10 * 5 * len(modes)
    pages = {mode: [median(samples[r, p, mode] for p in range(5)) * 1e6 / data["count"]
                    for r in range(10)] for mode in modes}
    print(f"| {label} | " + " | ".join(f"{median(pages[m]):,.1f}" for m in modes) + " |")
    points.append({mode: median(value / baseline for value, baseline in zip(pages[mode], pages["release"]))
                   for mode in modes})
assert len(versions) == 1

if args.plot:
    import matplotlib.pyplot as plt
    from matplotlib.ticker import FuncFormatter

    fig, ax = plt.subplots(figsize=(8.5, 3.8), layout="constrained")
    for i, row in enumerate(points):
        for shift, mode, color in [(-0.14, "bundled", "#227a70"), (0.14, "external", "#934785")]:
            y = i + shift
            left, right = row[mode], row["previous-" + mode]
            ax.plot([left, right], [y, y], color=color, alpha=0.5)
            ax.scatter(right, y, color="white", edgecolor=color, zorder=3)
            ax.scatter(left, y, color=color, zorder=3, label=mode.capitalize() if i == 0 else None)
    ax.axvline(1, ls="--", lw=1, color="#555")
    ax.set_xscale("log")
    ax.set_xticks([1, 2, 5, 10, 20, 50, 100])
    ax.xaxis.set_major_formatter(FuncFormatter(lambda x, _: f"{x:g}×"))
    ax.set_yticks(range(len(fixtures)), fixtures.values())
    ax.set_ylim(len(fixtures) - 0.6, -0.55)
    ax.set_xlabel("Call time relative to Jco 1.13.0 on the same page (lower is faster)")
    fig.suptitle("Calling numeric exports from JavaScript", fontweight="bold")
    ax.set_title("Open circles show the previous PR head. Filled circles show the optimized export.",
                 loc="left", fontsize=9)
    ax.grid(axis="x", alpha=0.15)
    ax.spines[["top", "right"]].set_visible(False)
    fig.legend(loc="outside lower center", ncol=2, frameon=False)
    fig.savefig(args.plot, dpi=140)
