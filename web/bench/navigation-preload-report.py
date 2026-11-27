"""Verify a cold-navigation trial against its asset inventory and summarize paired timings."""
import argparse
from collections import Counter
import gzip
import hashlib
import json
from pathlib import Path
from statistics import median

from sign_interval import median_sign_index

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("trial", type=Path)
parser.add_argument("matrix", type=Path)
args = parser.parse_args()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


with gzip.open(args.trial) as stream:
    trial = json.load(stream)
with gzip.open(args.matrix) as stream:
    matrix = json.load(stream)
assert trial["matrix"] == digest(args.matrix)
assert trial["candidate"] == matrix["candidate"] and trial["browser"] == matrix["chromium"]
assert trial["harness"] == digest(Path(__file__).with_name("navigation-preload.mjs"))
assert trial["assetsRunner"] == digest(Path(__file__).with_name("matrix-startup-phases.mjs"))
versions = ["release", "bundled", "external"]
rounds = trial["rounds"]
assert rounds == 12 and len(trial["samples"]) == 6 * rounds
samples = {}
positions, predecessors = Counter(), Counter()
for rnd in range(rounds):
    rows = sorted((r for r in trial["samples"] if r["round"] == rnd), key=lambda r: r["position"])
    order = [(r["version"], r["hints"]) for r in rows]
    assert set(order) == {(v, h) for v in versions for h in [True, False]}
    assert [r["position"] for r in rows] == list(range(6))
    positions.update(enumerate(order))
    predecessors.update(zip(order, order[1:]))
    for r in rows:
        version = r["version"]
        entries = next(s for s in matrix["samples"] if s["round"] == 0 and
                       (s["version"], s["demo"], s["lang"]) == (version, trial["demo"], trial["lang"]))
        paths = {asset["path"] for asset in entries["requests"]}
        assert sorted(paths) == trial["expected"][version]
        paths.update(["/host/common.js", "/host/web-host.js", "/examples/" + trial["demo"] + "/main.js"])
        assert sorted(paths) == sorted(r["served"])
        fetched = [q for q in r["requests"] if q["encoded"]]
        assert sorted(paths) == sorted(q["path"] for q in fetched)
        assert all(q["decoded"] == matrix["manifest"][q["path"]]["bytes"] for q in fetched)
        assert 0 < r["responseStart"] < r["ready"] <= r["first"]
        samples[rnd, version, r["hints"]] = r
assert len(positions) == 36 and len(predecessors) == 30
assert set(positions.values()) == set(predecessors.values()) == {2}


def durations(version, hints, key):
    return [samples[r, version, hints][key] for r in range(rounds)]


def ratio(after, before):
    paired = sorted(a / b for a, b in zip(after, before))
    idx = median_sign_index(len(paired))
    return f"{median(paired):.3f} ({paired[idx]:.3f}–{paired[-1-idx]:.3f})"


for v in versions:
    for k in ["ready", "first"]:
        stock, hinted = (durations(v, h, k) for h in [False, True])
        print(v, k, f"{median(stock):.2f} → {median(hinted):.2f} ms", ratio(hinted, stock),
              "hinted / hinted release", ratio(hinted, durations("release", True, k)))
