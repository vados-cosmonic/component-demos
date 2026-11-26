"""Compare source-phase imports to the ordinary loader within each Chromium process."""
import gzip
import json
import math
import sys
from collections import Counter
from hashlib import sha256
from pathlib import Path
from statistics import median

result_file, matrix_file, runner_file = map(Path, sys.argv[1:])
run = json.loads(gzip.decompress(result_file.read_bytes()))
matrix_bytes = matrix_file.read_bytes()
matrix = json.loads(gzip.decompress(matrix_bytes))
assert run["matrixSha256"] == sha256(matrix_bytes).hexdigest()
assert run["runnerSha256"] == sha256(runner_file.read_bytes()).hexdigest()
assert run["revision"] == matrix["candidate"] and run["chromium"] == matrix["chromium"]
assert run["chromiumFeature"] == "JavaScriptSourcePhaseImports" and run["study"] == "--source-import"
assert run["protocols"] == ["h2"] and run["profiles"] == ["loopback", "limited"]
assert run["emulation"] == {"latency": 40, "download": 1250000, "upload": 1250000}
assert run["contentEncoding"] == "br" and run["brotliQuality"] == 11
cases = run["cases"]
assert set(cases) == {f"{lang}/{demo}" for demo in ("dom-query", "table-update") for lang in ("c", "cpp", "rust")}
modes = ("release", "bundled", "external")
assert set(run["builds"]) == {mode + suffix for mode in modes for suffix in ("", "-source")}
assert run["rounds"] == 12
rounds = range(run["rounds"])
files = run["files"]
samples = {}
orders = {}
for sample in run["samples"]:
    case, mode, profile, rnd = (sample[k] for k in ("workload", "mode", "profile", "round"))
    key = case, mode, profile, rnd
    assert key not in samples
    expected = run["expected"][case][mode]
    requests = sample["requests"]
    assert sorted(r["path"] for r in requests) == expected["requests"] == sorted(sample["served"])
    assert len(expected["requests"]) == len(set(expected["requests"]))
    core, = (r for r in requests if r["path"].endswith(".wasm"))
    for r in requests:
        path = r["path"]
        if path != expected["entry"] or mode in modes:
            assert files[path]["sha256"] == matrix["manifest"][path]["sha256"]
        assert r["protocol"] == "h2" and r["bytes"] == files[path]["brotli"]
    samples[key] = sample["importMs"], sample["firstMs"], core["start"]
    orders.setdefault((case, rnd), {})[sample["position"]] = (mode, profile)
assert len(samples) == len(rounds) * len(cases) * len(run["builds"]) * len(run["profiles"])
for case in cases:
    positions, predecessors = Counter(), Counter()
    for rnd in rounds:
        order = [orders[case, rnd][i] for i in range(12)]
        positions.update(enumerate(order))
        predecessors.update(zip(order, order[1:]))
    assert len(positions) == 144 and len(predecessors) == 132
    assert set(positions.values()) == set(predecessors.values()) == {1}
    for mode in modes:
        a, b = (run["expected"][case][m] for m in (mode, mode + "-source"))
        assert set(a["requests"]) - {a["entry"]} == set(b["requests"]) - {b["entry"]}

def interval(values):
    # Exact two-sided sign interval; discrete coverage is at least 95%.
    n = len(values)
    rank = max(i for i in range(n // 2) if 2 * sum(math.comb(n, j) for j in range(i)) <= .05 * 2**n)
    values = sorted(values)
    return f"{median(values):.3f} ({values[rank]:.3f}–{values[-1-rank]:.3f})"

print("profile / mode | import ratio | first-result ratio | Wasm request launched earlier (ms) | first result / ordinary release")
for profile in run["profiles"]:
    for mode in modes:
        rows = []
        for rnd in rounds:
            effects = []
            for case in cases:
                ai, af, ac = samples[case, mode, profile, rnd]
                bi, bf, bc = samples[case, mode + "-source", profile, rnd]
                release = samples[case, "release", profile, rnd][1]
                effects.append((bi / ai, bf / af, ac - bc, bf / release))
            rows.append([median(v) for v in zip(*effects)])
        print(profile, mode, *[interval(list(v)) for v in zip(*rows)], sep=" | ")
