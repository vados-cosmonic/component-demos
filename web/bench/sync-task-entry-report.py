"""Report paired effects of changing the checked runtime module used by six adapters."""
import gzip
import json
import math
import sys
from hashlib import sha256
from pathlib import Path
from statistics import geometric_mean, median

run_file, matrix_file, runner_file = map(Path, sys.argv[1:])
run = json.loads(gzip.decompress(run_file.read_bytes()))
matrix_bytes = matrix_file.read_bytes()
assert run["matrixSha256"] == sha256(matrix_bytes).hexdigest()
matrix = json.loads(gzip.decompress(matrix_bytes))
assert run["revision"] == matrix["candidate"] and run["chromium"] == matrix["chromium"]
assert run["emulation"] == {"latency": 40, "download": 1250000, "upload": 1250000}
assert run["runnerSha256"] == sha256(runner_file.read_bytes()).hexdigest()
assert run["study"] == "--sync-task-entry" and run["rounds"] == 16
control, trial = run["builds"]
assert (control, trial) == ("external", "sync-task")
cases = run["cases"]
assert set(cases) == {f"{lang}/{demo}" for lang in ("c", "cpp", "rust")
                      for demo in ("dom-query", "table-update")}
profiles = run["profiles"]
assert profiles == ["loopback", "limited"]
rounds = range(run["rounds"])
files = run["files"]
samples = {}
for sample in run["samples"]:
    key = (sample["profile"], sample["round"], sample["workload"], sample["mode"])
    assert key not in samples
    samples[key] = sample
    requests = sample["requests"]
    assert sorted(r["path"] for r in requests) == run["expected"][key[2]][key[3]]["requests"]
    assert all(r["protocol"] == "h2" and r["bytes"] == files[r["path"]]["brotli"]
               and r["decoded"] == files[r["path"]]["bytes"] for r in requests)
assert len(samples) == len(profiles) * len(rounds) * len(cases) * 2

def size(paths, field):
    return sum(files[p][field] for p in paths)

for case in cases:
    roots = [run["expected"][case][m]["requests"] for m in (control, trial)]
    assert set(p for p in roots[0] if not p.startswith("/runtime/")) == set(
        p for p in roots[1] if not p.startswith("/grouped/"))
    for mode, prefix, paths in zip((control, trial), ("/runtime/", "/grouped/"), roots):
        runtime = [p for p in paths if p.startswith(prefix)]
        print(case, mode, len(runtime), size(runtime, "bytes"), size(runtime, "brotli"))

entries = run["footprints"][control]
assert entries.keys() == run["footprints"][trial].keys()
deltas = {entry: size(run["footprints"][trial][entry], "bytes") - size(paths, "bytes")
          for entry, paths in entries.items()}
print("Standalone entries growing in raw bytes:", {k: v for k, v in deltas.items() if v > 0})

def describe(values):
    # Largest symmetric order-statistic bound with at least 95% coverage.
    n = len(values)
    rank = max(i for i in range(n // 2) if
               2 * sum(math.comb(n, j) for j in range(i)) <= 0.05 * 2**n)
    values = sorted(values)
    return f"{median(values):.3f} ({values[rank]:.3f}–{values[-1-rank]:.3f})"

for profile in profiles:
    for field in ("importMs", "firstMs"):
        by_case = {case: [samples[profile, r, case, trial][field] /
                          samples[profile, r, case, control][field] for r in rounds] for case in cases}
        # Within a round, all six workloads share one browser process.
        print(profile, field, "six-workload ratio",
              describe([geometric_mean(group) for group in zip(*by_case.values())]))
        for case, ratios in by_case.items():
            print(" ", case, describe(ratios))
