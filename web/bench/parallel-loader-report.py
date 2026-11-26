"""Check the C table loader trial and report paired ratios within each browser."""
from sign_interval import median_sign_index
from collections import Counter
import gzip
from hashlib import sha256
import json
from pathlib import Path
from statistics import median
import sys

archive, matrix_path, runner = map(Path, sys.argv[1:])
load = lambda path: json.loads(gzip.decompress(path.read_bytes()))
run, matrix = load(archive), load(matrix_path)
assert run["study"] == "--parallel-loader" and run["cases"] == ["c/table-update"]
assert run["runnerSha256"] == sha256(runner.read_bytes()).hexdigest()
assert run["matrixSha256"] == sha256(matrix_path.read_bytes()).hexdigest()
assert run["revision"] == matrix["candidate"] and run["chromium"] == matrix["chromium"]
assert run["protocols"] == ["h2"] and run["contentEncoding"] == "br" and run["brotliQuality"] == 11
assert run["emulation"] == {"latency": 40, "download": 1250000, "upload": 1250000}
case = run["cases"][0]
assert run["inputs"]["table-update"] == [matrix["workloads"]["table-update"]["rows"]]
profiles = ["loopback", "limited"]
modes = ["release", "bundled", "external", "bundled-serial", "bundled-parallel", "external-serial", "external-parallel"]
assert run["builds"] == modes and run["profiles"] == profiles and run["rounds"] == 14
rounds = range(run["rounds"])
samples, orders = {}, {}
for s in run["samples"]:
    mode, profile, rnd = (s[k] for k in ("mode", "profile", "round"))
    assert s["workload"] == case and (mode, profile, rnd) not in samples
    expected = run["expected"][case][mode]
    paths = expected["requests"]
    assert sorted(r["path"] for r in s["requests"]) == paths == sorted(s["served"])
    assert len(set(paths)) == len(paths)
    for req in s["requests"]:
        path = req["path"]
        assert req["protocol"] == "h2" and req["bytes"] == run["files"][path]["brotli"]
        if mode in ("release", "external", "bundled") or path.startswith("/runtime/"):
            assert run["files"][path]["sha256"] == matrix["manifest"][path]["sha256"]
    if "-" in mode:
        assert len(expected["cores"]) == 4
    samples[mode, profile, rnd] = s
    orders.setdefault(rnd, {})[s["position"]] = (profile, mode)
positions, predecessors = Counter(), Counter()
for rnd in rounds:
    order = [orders[rnd][i] for i in range(14)]
    positions.update(enumerate(order))
    predecessors.update(zip(order, order[1:]))
assert len(samples) == 196 and len(positions) == 196 and len(predecessors) == 182
assert set(positions.values()) == set(predecessors.values()) == {1}
for mode in ("bundled", "external"):
    for field in ("entry", "cores", "requests"):
        assert run["expected"][case][mode + "-parallel"][field] == run["expected"][case][mode + "-serial"][field]

def describe(v):
    v = sorted(v)
    rank = median_sign_index(len(v))
    return f"{median(v):.3f} ({v[rank]:.3f}–{v[-1-rank]:.3f})"

for profile in profiles:
    for mode in modes:
        rows = [samples[mode, profile, rnd] for rnd in rounds]
        print(profile, mode, "median ready / first result (ms)", *(round(median(r[k] for r in rows), 2) for k in ("importMs", "firstMs")))
    for mode in ("bundled", "external"):
        for control in (mode + "-serial", mode, "release"):
            def ratios(key):
                return [samples[mode + "-parallel", profile, r][key] / samples[control, profile, r][key] for r in rounds]
            print(profile, mode + "-parallel / " + control, describe(ratios("importMs")), describe(ratios("firstMs")))
