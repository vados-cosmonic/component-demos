"""Check the paired DOM trials and report page-level time ratios and sign-test intervals."""
import argparse
from collections import Counter, defaultdict
import gzip
from hashlib import sha256
import json
from math import comb
from pathlib import Path
from statistics import median

bench = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("input", type=Path, nargs="?", default=bench / "results/paired-dom-review.json.gz")
parser.add_argument("--plot", type=Path)
args = parser.parse_args()
source = args.input
with gzip.open(source) as f:
    run = json.load(f)
matrix_name = "review-matrix-minified-eaca992c8.json.gz" if run.get("minify") else "review-matrix.json.gz"
assert run["matrixSha256"] == sha256((bench / "results" / matrix_name).read_bytes()).hexdigest()
# The archived run used the runner and packer from benchmark commit 5f57d0c9.
# Verify the entire archived payload, including its original source fingerprints.
# Fresh measurements verify the source fingerprints against the installed scripts.
archived_sha256 = "b3a1beb8a9c31120367d4f02722ea7dec9f5e8412bbdce150f91341bb07df045"
if sha256(source.read_bytes()).hexdigest() != archived_sha256:
    for key, name in [("runnerSha256", "paired-dom-review.mjs"), ("packerSha256", "shared-provider.mjs")]:
        if run[key] != sha256((bench / name).read_bytes()).hexdigest():
            raise ValueError(f"{name} does not match the source used for these samples")
cells = defaultdict(dict)
order = defaultdict(dict)
for row in run["samples"]:
    # Historical samples had one language per workload.
    lang = row.get("lang") or next(c["lang"] for c in run["cases"] if c["demo"] == row["demo"])
    key = (lang, row["demo"]), row["round"], row["pass"]
    assert row["mode"] not in cells[key] and row["position"] not in order[key]
    cells[key][row["mode"]] = row["times"]
    order[key][row["position"]] = row["mode"]
rounds = run["rounds"]
for case in run["cases"]:
    demo = case["lang"], case["demo"]
    for r in range(rounds):
        for first in (0, 4):
            positions, transitions = Counter(), Counter()
            for p in range(first, first + 4):
                key = demo, r, p
                assert set(cells[key]) == set(run["modes"]) and set(order[key]) == set(range(4))
                labels = [order[key][i] for i in range(4)]
                positions.update(enumerate(labels))
                transitions.update(zip(labels, labels[1:]))
            assert len(positions) == 16 and set(positions.values()) == {1}
            assert len(transitions) == 12 and set(transitions.values()) == {1}
assert len(cells) == len(run["cases"]) * rounds * 8
# Exact distribution-free interval from the order statistics of independent page medians.
k = max(i for i in range(rounds) if 2 * sum(comb(rounds, j) for j in range(i + 1)) / 2 ** rounds <= .05)
def compare(demo, metric, a, b, passes):
    ratios = []
    for r in range(rounds):
        ratios.append(median(cells[demo,r,p][a][metric] / cells[demo,r,p][b][metric] for p in passes))
    return median(ratios), sorted(ratios)[k], sorted(ratios)[-k-1]

print("| Workload phase | Internal / 1.13.0 | External / 1.13.0 | Packed / external |")
print("| --- | ---: | ---: | ---: |")
phases = {
    "table-update": [("create: total ms", "table creation"), ("update (selected): total ms", "selected-row update"),
                     ("clear (unselected): total ms", "unselected-row removal")],
    "dom-traversal": [("build", "tree construction"), ("traverse (total)", "tree traversal")],
}
languages = {"c": "C", "cpp": "C++", "rust": "Rust"}
for case in run["cases"]:
    lang, demo = case["lang"], case["demo"]
    for metric, title in phases[demo]:
        values = []
        for a, b in [("bundled", "release"), ("external", "release"), ("packed", "external")]:
            ratio, lo, hi = compare((lang, demo), metric, a, b, range(4, 8))
            values.append(f"{ratio:.2f}× ({lo:.2f}–{hi:.2f})")
        print("|", " | ".join([languages[lang] + " " + title, *values]), "|")
for case in run["cases"]:
    lang, demo = case["lang"], case["demo"]
    headline = "create: total ms" if demo == "table-update" else "traverse (total)"
    print(lang, demo, "external / release by guest invocation:",
          [round(compare((lang, demo), headline, "external", "release", [p])[0], 3) for p in range(8)])

if args.plot:
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(7.8, 3.8), layout="constrained")
    ticks = []
    for i, case in enumerate(run["cases"]):
        lang, demo = case["lang"], case["demo"]
        metric, title = phases[demo][0 if demo == "table-update" else 1]
        ticks.append(languages[lang] + " " + title)
        for mode, label, offset, marker, color in [
            ("bundled", "Internal Oxc", -0.12, "o", "#00796B"),
            ("external", "External runtime", 0.12, "x", "#AD4524"),
        ]:
            mid, lo, hi = compare((lang, demo), metric, mode, "release", range(4, 8))
            ax.errorbar(mid, i + offset, xerr=[[mid - lo], [hi - mid]], fmt=marker,
                        color=color, capsize=2, label=label if i == 0 else None)
    ax.axvline(1, color="#555", lw=1)
    ax.set_yticks(range(len(ticks)), ticks)
    ax.invert_yaxis()
    ax.set_xlabel("Warm guest time / Jco 1.13.0 time")
    ax.grid(axis="x", alpha=.2)
    fig.legend(*ax.get_legend_handles_labels(), loc="outside lower center", ncol=2)
    fig.savefig(args.plot, dpi=160)
