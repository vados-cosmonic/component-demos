"""Verify the table allocator experiment and summarize paired time ratios."""
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
with gzip.open(args.samples) as stream:
    run = json.load(stream)
with gzip.open(args.matrix) as stream:
    matrix = json.load(stream)
assert hashlib.sha256(args.matrix.read_bytes()).hexdigest() == run["matrix"]
runner = Path(__file__).with_name("table-handle-space.mjs")
assert hashlib.sha256(runner.read_bytes()).hexdigest() == run["runner"]
assert run["rows"] == matrix["workloads"]["table-update"]["rows"] == 2000
for path, patch in run["patches"].items():
    assert matrix["manifest"][path]["sha256"] == patch["original"] != patch["cached"]
assert sorted(p["sites"] for p in run["patches"].values()) == [2, 3]
requests = {s["version"]: sorted(req["path"] for req in s["requests"])
            for s in matrix["samples"] if s["round"] == 0 and s["demo"] == "table-update" and s["lang"] == "c"}
modes = {"release", "bundled", "bundled-cache", "external", "external-cache"}
assert {r["treatment"] for r in run["audits"]} == modes and len(run["audits"]) == len(modes)
for row in run["audits"]:
    mode = row["treatment"]
    assert row["requests"] == requests[mode.split("-")[0]]
    marks = row["observations"]
    assert [mark["name"] for mark in marks] == ["create-start", "create-end"] * 2
    counts = [marks[i + 1]["lookups"] - marks[i]["lookups"] for i in (0, 2)]
    if mode in ("bundled", "external"):
        assert counts == [12002, 12002] and row["lookups"] == 32272
    elif mode.endswith("-cache"):
        assert counts == [0, 0] and row["lookups"] == 7
    print(mode, "lookups during row creation", counts, "over two whole guest calls", row["lookups"])

rounds = range(20)
pages = {}
positions, predecessors = Counter(), Counter()
for r in rounds:
    group = sorted((row for row in run["samples"] if row["round"] == r), key=lambda row: row["position"])
    order = [row["treatment"] for row in group]
    assert set(order) == modes and [row["position"] for row in group] == list(range(5))
    positions.update(enumerate(order))
    predecessors.update(zip(order, order[1:]))
    for row in group:
        mode = row["treatment"]
        assert row["lookups"] == 0 and row["observations"] == []
        assert row["requests"] == requests[mode.split("-")[0]]
        assert len(row["calls"]) == 8 and all(0 < c["createMs"] <= c["guestMs"] for c in row["calls"])
        pages[r, mode] = row
assert len(run["samples"]) == len(pages) == 100
assert len(positions) == 25 and len(predecessors) == 20
assert set(positions.values()) == set(predecessors.values()) == {4}

def summary(values):
    ordered = sorted(values)
    # Two-sided nonparametric sign interval, at least 95% for 20 pairs.
    return f"{median(ordered):.3f} ({ordered[5]:.3f}–{ordered[-6]:.3f})"

for label, metric, indices in [("first creation", "createMs", [0]), ("second creation", "createMs", [1]),
                               ("creation on calls 5–8", "createMs", range(4, 8)),
                               ("complete calls 1–8", "guestMs", range(8))]:
    def values(mode):
        return [sum(pages[r, mode]["calls"][i][metric] for i in indices) for r in rounds]
    print(label)
    print("release median ms", round(median(values("release")), 3))
    for mode in ["bundled", "external"]:
        base, cached = values(mode), values(mode + "-cache")
        print(mode, "control and cache median ms", round(median(base), 3), round(median(cached), 3),
              "paired cache/control", summary(c / b for c, b in zip(cached, base)),
              "paired control/release", summary(b / t for b, t in zip(base, values("release"))))

# Import includes module initialization. The rest of time to first result is
# measured on the same document, so subtract before pairing with the release.
controls = {(s["round"], s["version"]): s for s in matrix["samples"]
            if s["lang"] == "c" and s["demo"] == "table-update"}
paired_rounds = sorted(r for r, v in controls if v == "release")
assert len(paired_rounds) == 18
for name, metric in [
    ("import and initialization", lambda s: s["loadMs"]),
    ("first guest call", lambda s: s["firstResultMs"] - s["loadMs"]),
    ("creation during first call", lambda s: s["cold"]["create: total ms"] * 1000),
    ("time to first result", lambda s: s["firstResultMs"]),
]:
    for mode in ["bundled", "external"]:
        deltas = sorted(metric(controls[r, mode]) - metric(controls[r, "release"]) for r in paired_rounds)
        print("full matrix", name, mode, "paired ms over release",
              f"{median(deltas):.2f} ({deltas[4]:.2f} to {deltas[-5]:.2f})")
