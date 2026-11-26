"""Validate cold startup samples and report wall-clock intervals and JS coverage."""
import argparse
from collections import Counter
import gzip
import hashlib
import json
from pathlib import Path
from statistics import median

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("samples", type=Path)
parser.add_argument("matrix", type=Path)
args = parser.parse_args()
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
with gzip.open(args.samples) as stream:
    run = json.load(stream)
with gzip.open(args.matrix) as stream:
    matrix = json.load(stream)
assert digest(args.matrix) == run["matrix"] and matrix["candidate"] == run["candidate"]
assert digest(Path(__file__).with_name("matrix-startup-phases.mjs")) == run["runner"]
assert run["browser"] == matrix["chromium"]
versions = ["release", "bundled", "external"]
refs = {row["version"]: row for row in matrix["samples"] if
        row["round"] == 0 and row["lang"] == run["lang"] and row["demo"] == run["demo"]}
phases, positions, predecessors = {}, Counter(), Counter()
for rnd in range(18):
    rows = sorted((r for r in run["samples"] if r["round"] == rnd), key=lambda r: r["position"])
    order = [r["version"] for r in rows]
    assert set(order) == set(versions) and [r["position"] for r in rows] == list(range(3))
    positions.update(enumerate(order))
    predecessors.update(zip(order, order[1:]))
    for r in rows:
        v = r["version"]
        requests = r["requests"]
        assert sorted(req["path"] for req in requests) == sorted(req["path"] for req in refs[v]["requests"])
        assert all(req["bytes"] == matrix["manifest"][req["path"]]["bytes"] for req in requests)
        end_entry = next(req["end"] for req in requests if req["path"] == run["entries"][v])
        end_js = max(req["end"] for req in requests if req["path"].endswith(".js"))
        wasm, = (req for req in requests if req["path"].endswith(".wasm"))
        marks = [0, end_entry, end_js, wasm["start"], wasm["end"], r["ready"], r["firstResult"]]
        assert marks == sorted(marks), marks
        phases[rnd, v] = [b-a for a, b in zip(marks, marks[1:])] + [r["ready"]]
assert len(run["samples"]) == len(phases) == 54
assert len(positions) == 9 and len(predecessors) == 6 and set(positions.values()) == set(predecessors.values()) == {6}
for idx, label in enumerate(["entry response", "remaining JS responses", "final JS response to Wasm request",
                             "Wasm request to response end", "Wasm response end to ready", "first guest call", "total import"]):
    values = {v: [phases[r, v][idx] for r in range(18)] for v in versions}
    print(label, *(f"{v} {median(values[v]):.2f} ms" for v in versions))
    for v in versions[1:]:
        delta = sorted(x - y for x, y in zip(values[v], values["release"]))
        print(f"  paired {v} / release difference {median(delta):.2f} ({delta[4]:.2f} to {delta[-5]:.2f}) ms")
assert {(r["version"], r["runGuest"]) for r in run["coverage"]} == {(v, g) for v in versions for g in [False, True]}
for r in run["coverage"]:
    v = r["version"]
    files = r["scripts"]
    assert sorted(f["path"] for f in files) == sorted(req["path"] for req in refs[v]["requests"] if req["path"].endswith(".js"))
    assert all(0 <= f["reached"] <= f["bytes"] == matrix["manifest"][f["path"]]["bytes"] for f in files)
    print(v, "first result" if r["runGuest"] else "import", "reached bytes", sum(f["reached"] for f in files),
          "served JS bytes", sum(f["bytes"] for f in files))
