"""Check the callback and ordering controls and summarize Chromium lock costs."""
import argparse
from collections import Counter
import gzip
import hashlib
import json
from pathlib import Path
from statistics import median

from sign_interval import median_sign_index

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("study", type=Path)
parser.add_argument("matrix", type=Path)
args = parser.parse_args()
run = json.loads(gzip.decompress(args.study.read_bytes()))
matrix_bytes = args.matrix.read_bytes()
assert hashlib.sha256(matrix_bytes).hexdigest() == run["matrixSha256"]
assert json.loads(gzip.decompress(matrix_bytes))["chromium"] == run["chromium"]
runner = Path(__file__).with_name("lock-release.mjs")
assert hashlib.sha256(runner.read_bytes()).hexdigest() == run["runnerSha256"]
assert run["counts"] == [0, 1, 4, 32] and run["rounds"] == 16

rows, positions = {}, Counter()
once = ["first", "later", "later", "returned"]
for row in run["samples"]:
    r, count, mode, pos = (row[k] for k in ("round", "count", "mode", "position"))
    key = (r, count, mode)
    assert key not in rows and r in range(16) and count in run["counts"] and pos in range(2)
    assert mode in ("before", "after")
    assert row["order"] == (once if mode == "after" else once + ["later", "later"])
    assert row["iterations"] == (262144 if count == 0 else max(4096, 65536 // count))
    assert len(row["ns"]) == 5 and min(row["ns"]) > 0
    rows[key] = median(row["ns"])
    positions[count, mode, pos] += 1
assert len(rows) == 128 and len(positions) == 16 and set(positions.values()) == {8}

print("callbacks | before ns | after ns | paired after / before (individual 95% interval)")
rank = median_sign_index(16)
for count in run["counts"]:
    before, after = [[rows[r, count, mode] for r in range(16)] for mode in ("before", "after")]
    ratios = sorted(y / x for x, y in zip(before, after))
    print(f"{count:2} | {median(before):.2f} | {median(after):.2f} | "
          f"{median(ratios):.3f} ({ratios[rank]:.3f}–{ratios[-1-rank]:.3f})")
