"""Summarize per-instance live JavaScript heap across the five Chromium treatments."""
import argparse
import gzip
import hashlib
import json
from collections import defaultdict
from itertools import pairwise
from pathlib import Path
from statistics import median

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("samples", type=Path)
parser.add_argument("entry_comparison", type=Path)
args = parser.parse_args()
with gzip.open(args.samples) as source:
    data = json.load(source)
runner = Path(__file__).with_name("capture-instance-heap.mjs")
assert data["runner"] == hashlib.sha256(runner.read_bytes()).hexdigest()
assert data["entryComparison"] == hashlib.sha256(args.entry_comparison.read_bytes()).hexdigest()
rows = defaultdict(dict)
for sample in data["samples"]:
    mode, index = sample["mode"], sample["round"]
    assert index not in rows[mode] and len(sample["keys"]) == 6
    assert len(sample["snapshots"]) == len(data["populations"]) == 3
    estimates = []
    for key in ("usedSize", "backingStorageSize"):
        sizes = [snap[key] for snap in sample["snapshots"]]
        estimates.append([(b - a) / (high - low)
                          for (a, b), (low, high) in zip(pairwise(sizes), pairwise(data["populations"]))])
    rows[mode][index] = estimates
assert len(rows) == 5 and all(set(r) == set(range(10)) for r in rows.values())
for mode, samples in rows.items():
    print(mode, "median live JS, then backing store per instance, increments 8→40 and 40→72:",
          *[round(median(s[field][step] for s in samples.values())) for field in range(2) for step in range(2)])
for mode in ("bundled", "external"):
    before, after = (rows[label + "-" + mode] for label in ("before", "after"))
    for step in range(2):
        diffs = sorted(before[i][0][step] - after[i][0][step] for i in before)
        # With ten paired rounds the second and ninth differences give 97.85%
        # coverage for a continuous population median under the sign test.
        print(mode, "JS bytes saved per instance, step", step + 1, "median (97.85% sign interval)",
              *(round(x) for x in (median(diffs), diffs[1], diffs[-2])))
