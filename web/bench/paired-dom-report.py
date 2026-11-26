"""Check the paired DOM trials and report page-level time ratios and sign-test intervals."""
from collections import Counter, defaultdict
import gzip
from hashlib import sha256
import json
from math import comb
from pathlib import Path
from statistics import median
import sys

bench = Path(__file__).resolve().parent
source = Path(sys.argv[1]) if len(sys.argv) > 1 else bench / "results/paired-dom-review.json.gz"
with gzip.open(source) as f:
    run = json.load(f)
for key, name in [("runnerSha256", "paired-dom-review.mjs"), ("matrixSha256", "results/review-matrix.json.gz"),
                  ("packerSha256", "shared-provider.mjs")]:
    assert run[key] == sha256((bench / name).read_bytes()).hexdigest()
cells = defaultdict(dict)
order = defaultdict(dict)
for row in run["samples"]:
    key = row["demo"], row["round"], row["pass"]
    assert row["mode"] not in cells[key] and row["position"] not in order[key]
    cells[key][row["mode"]] = row["times"]
    order[key][row["position"]] = row["mode"]
rounds = run["rounds"]
for case in run["cases"]:
    demo = case["demo"]
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
for demo, metric, title in [
    ("table-update", "create: total ms", "C table creation"),
    ("table-update", "update (selected): total ms", "C selected-row update"),
    ("table-update", "clear (unselected): total ms", "C unselected-row removal"),
    ("dom-traversal", "build", "Rust tree construction"),
    ("dom-traversal", "traverse (total)", "Rust tree traversal"),
]:
    values = []
    for a, b in [("bundled", "release"), ("external", "release"), ("packed", "external")]:
        ratio, lo, hi = compare(demo, metric, a, b, range(4, 8))
        values.append(f"{ratio:.2f}× ({lo:.2f}–{hi:.2f})")
    print("|", " | ".join([title, *values]), "|")
for demo, metric in [("table-update", "create: total ms"), ("dom-traversal", "traverse (total)")]:
    print(demo, "external / release by guest invocation:",
          [round(compare(demo, metric, "external", "release", [p])[0], 3) for p in range(8)])
