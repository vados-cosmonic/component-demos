"""Summarize HTTP/2 startup when several synchronous runtime imports share one entry."""
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
assert (run["matrixSha256"], run["runnerSha256"], run["chromium"]) == (
    digest(args.matrix), digest(args.runner), matrix["chromium"])
assert run["study"] == "--compare-facades" and run["protocols"] == ["h2"]
assert run["profiles"] == ["loopback", "limited"] and run["rounds"] == 16
assert run["brotliQuality"] == 11 and run["emulation"] == {"latency": 40, "download": 1250000, "upload": 1250000}
builds = run["builds"]
assert builds == ["release", "external", "separate", "extended"]
cases = run["cases"]
assert set(cases) == {lang + "/" + demo for lang in ("c", "cpp", "rust") for demo in ("dom-query", "table-update")}
files = run["files"]
for path, info in files.items():
    if path.startswith(("/separate/", "/extended/")):
        continue
    assert info["sha256"] == matrix["manifest"][path]["sha256"]
    assert info["bytes"] == matrix["manifest"][path]["bytes"]
# A separate entry can reuse the shipping chunks without changing the bytes
# of the other public entries. Check the actual files served in the trial.
for path, reference in files.items():
    if not path.startswith("/runtime/"):
        continue
    for mode in ("separate", "extended"):
        if mode == "extended" and path == "/runtime/intrinsics/sync-task.js":
            continue
        candidate = path.replace("/runtime/", "/" + mode + "/", 1)
        assert files[candidate]["sha256"] == reference["sha256"], candidate
sync_task = "intrinsics/sync-task"
for mode in ("external", "extended"):
    paths = run["footprints"][mode][sync_task]
    print(mode, "standalone sync-task Brotli bytes", sum(files[p]["brotli"] for p in paths))
samples, positions = {}, defaultdict(Counter)
for s in run["samples"]:
    profile, case, mode, rnd = (s[k] for k in ("profile", "workload", "mode", "round"))
    key = (rnd, profile, case, mode)
    assert key not in samples and rnd in range(run["rounds"])
    samples[key] = s
    positions[case, profile, mode][s["position"]] += 1
    expected = run["expected"][case][mode]["requests"]
    control = run["expected"][case]["release" if mode == "release" else "external"]
    assert run["expected"][case][mode]["entry"] == control["entry"]
    assert [p for p in expected if not p.startswith(("/runtime/", "/separate/", "/extended/"))] == [
        p for p in control["requests"] if not p.startswith("/runtime/")
    ]
    assert sorted(s["served"]) == sorted(r["path"] for r in s["requests"]) == expected
    for r in s["requests"]:
        assert (r["protocol"], r["bytes"], r["decoded"]) == ("h2", files[r["path"]]["brotli"], files[r["path"]]["bytes"])
assert len(samples) == 16 * 2 * len(cases) * len(builds)
assert all(counts == Counter({i: 2 for i in range(8)}) for counts in positions.values())

for mode, prefix in [("external", "/runtime/"), ("separate", "/separate/"), ("extended", "/extended/")]:
    totals = set()
    for case in cases:
        paths = [p for p in run["expected"][case][mode]["requests"] if p.startswith(prefix)]
        totals.add((len(paths), sum(files[p]["bytes"] for p in paths), sum(files[p]["brotli"] for p in paths)))
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
    for mode in ("separate", "extended"):
        for field, against in (("importMs", "external"), ("firstMs", "external"), ("firstMs", "release")):
            ratios = [geometric_mean(samples[r, profile, c, mode][field] /
                                     samples[r, profile, c, against][field] for c in cases)
                      for r in range(run["rounds"])]
            print(profile, field, mode, "/", against, describe(ratios))
        def last_runtime(sample):
            return max(req["end"] for req in sample["requests"]
                       if req["path"].startswith(("/separate/", "/extended/", "/runtime/")))
        deltas = [median(last_runtime(samples[r, profile, c, mode]) -
                         last_runtime(samples[r, profile, c, "external"]) for c in cases)
                  for r in range(run["rounds"])]
        print(profile, "last runtime response time difference (ms)", mode, describe(deltas))
