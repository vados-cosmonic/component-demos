"""Summarize cold loading of the shipped task entry and its preceding package."""
from sign_interval import median_sign_index
import argparse
import gzip
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path
from statistics import geometric_mean, median

parser = argparse.ArgumentParser(description=__doc__)
for arg in ("run", "matrix", "runner"):
    parser.add_argument(arg, type=Path)
args = parser.parse_args()
load = lambda path: json.loads(gzip.decompress(path.read_bytes()))
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
run, matrix = load(args.run), load(args.matrix)
assert (run["revision"], run["matrixSha256"], run["runnerSha256"], run["chromium"]) == (
    matrix["candidate"], digest(args.matrix), digest(args.runner), matrix["chromium"])
assert run["study"] == "--compare-packages" and run["protocols"] == ["h2"]
assert run["profiles"] == ["loopback", "limited"] and run["rounds"] == 16
assert run["brotliQuality"] == 11 and run["emulation"] == {"latency": 40, "download": 1250000, "upload": 1250000}
builds = run["builds"]
assert builds == ["release", "bundled", "previous-external", "external"]
cases = run["cases"]
assert set(cases) == {lang + "/" + demo for lang in ("c", "cpp", "rust") for demo in ("dom-query", "table-update")}
files = run["files"]
for path, info in files.items():
    assert info["sha256"] == matrix["manifest"][path]["sha256"]
    assert info["bytes"] == matrix["manifest"][path]["bytes"]
samples, positions = {}, defaultdict(Counter)
for s in run["samples"]:
    profile, case, mode, rnd = (s[k] for k in ("profile", "workload", "mode", "round"))
    key = (rnd, profile, case, mode)
    assert key not in samples and rnd in range(run["rounds"])
    samples[key] = s
    positions[case, profile, mode][s["position"]] += 1
    expected = run["expected"][case][mode]["requests"]
    assert sorted(s["served"]) == sorted(r["path"] for r in s["requests"]) == expected
    for r in s["requests"]:
        assert (r["protocol"], r["bytes"], r["decoded"]) == ("h2", files[r["path"]]["brotli"], files[r["path"]]["bytes"])
assert len(samples) == 16 * 2 * len(cases) * len(builds)
assert all(counts == Counter({i: 2 for i in range(8)}) for counts in positions.values())

for mode, prefix in [("previous-external", "/previous-runtime/"), ("external", "/runtime/")]:
    totals = set()
    for case in cases:
        paths = [p for p in run["expected"][case][mode]["requests"] if p.startswith(prefix)]
        totals.add((len(paths), sum(files[p]["bytes"] for p in paths), sum(files[p]["brotli"] for p in paths)))
        assert (prefix + "intrinsics/sync-task.js" in paths) == (mode == "external")
        assert (prefix + "intrinsics/async-task.js" in paths) == (mode == "previous-external")
    assert len(totals) == 1
    print(mode, "runtime requests, raw bytes and Brotli bytes", totals.pop())

def describe(ratios):
    ordered = sorted(ratios)
    n = len(ordered)
    rank = median_sign_index(n)
    return f"{median(ordered):.3f} ({ordered[rank]:.3f}–{ordered[-1-rank]:.3f})"

for profile in run["profiles"]:
    for mode in builds:
        typical = median(median(samples[r, profile, c, mode]["firstMs"] for r in range(16)) for c in cases)
        print(profile, mode, "median first result (ms)", round(typical, 2))
    for field, against in [("importMs", "previous-external"), ("firstMs", "previous-external"),
                           ("firstMs", "release"), ("firstMs", "bundled")]:
        # Every process supplies all workloads and treatments. Pair before
        # aggregating so differences between Chromium processes cancel.
        ratios = [geometric_mean(samples[r, profile, c, "external"][field] /
                                 samples[r, profile, c, against][field] for c in cases)
                  for r in range(run["rounds"])]
        print(profile, field, "external /", against, describe(ratios))
