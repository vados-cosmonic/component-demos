"""Pair C table calls with the same entry served with and without resource-drop history."""
import argparse
from collections import Counter
import gzip
import hashlib
import json
from math import comb
from pathlib import Path
from statistics import median

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("samples", type=Path)
parser.add_argument("matrix", type=Path)
parser.add_argument("--plot", type=Path)
args = parser.parse_args()
run, matrix = [json.load(gzip.open(path)) for path in (args.samples, args.matrix)]


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()

assert run["dropHistoryControl"] and run["measureStages"] and run["language"] == "c"
assert run["runnerSha256"] == digest(Path(__file__).with_name("table-warmup.mjs"))
assert run["matrixSha256"] == digest(args.matrix) and run["revision"] == matrix["candidate"]
rounds, calls = run["rounds"], run["calls"]
assert (rounds, calls, run["rows"]) == (28, 24, matrix["workloads"]["table-update"]["rows"])
versions = run["versions"]
assert versions == ["release", "bundled", "external"]
arms = {(v, history) for v in versions
        for history in (["normal"] if v == "release" else ["normal", "omit", "grouped"])}
paths = {s["version"]: s for s in matrix["samples"]
         if s["round"] == 0 and s["lang"] == "c" and s["demo"] == "table-update" and s["version"] in versions}
for v, patch in run["modifications"].items():
    assert patch["sites"] > 0 and patch["original"] == matrix["manifest"][paths[v]["entry"]]["sha256"]
    assert len({patch["original"], patch["omit"], patch["grouped"]}) == 3
assert set(run["modifications"]) == {"bundled", "external"}

def arm(row):
    return row["version"], row["history"]

def check_requests(row):
    assert row["requests"] == sorted(q["path"] for q in paths[row["version"]]["requests"])

call_audits = [row for row in run["audits"] if not row.get("stopAudit")]
stop_audits = [row for row in run["audits"] if row.get("stopAudit")]
assert len(call_audits) == len(arms) and set(map(arm, call_audits)) == arms
assert len(stop_audits) == len(arms) - 1 and set(map(arm, stop_audits)) == arms - {("release", "normal")}
for row in call_audits:
    check_requests(row)
    assert row["historyWrites"] == (0 if row["history"] == "omit" or row["version"] == "release" else 2 * run["rows"] + 1)
    assert row["counts"] == {"createElement": 2 * run["rows"], "setTextContent": run["rows"], "appendChild": 2 * run["rows"]}
for row in stop_audits:
    check_requests(row)
    assert row["trapped"] and row["stopping"] and row["disposals"] == (2 if row["history"] == "omit" else 1)

stages, positions, predecessors = {}, Counter(), Counter()
for r in range(rounds):
    group = sorted((s for s in run["samples"] if s["round"] == r), key=lambda s: s["position"])
    order = list(map(arm, group))
    assert [s["position"] for s in group] == list(range(len(arms))) and set(order) == arms
    positions.update(enumerate(order))
    predecessors.update(zip(order, order[1:]))
    for s in group:
        check_requests(s)
        assert s["warmup"] == "none" and len(s["measurements"]) == len(s["stages"]) == calls
        for timings, marks in zip(s["measurements"], s["stages"], strict=True):
            assert list(marks) == ["entry", "c-start", "create-start", "create-end", "update-start",
                                   "update-end", "clear-start", "clear-end", "c-end", "return"]
            timestamps = list(marks.values())
            assert timestamps == sorted(timestamps) and timestamps[0] == 0
            assert abs(timings["create: total ms"] * 1000 - (marks["create-end"] - marks["create-start"])) < .012
        stages[r, *arm(s)] = s["stages"]
assert len(run["samples"]) == len(stages) == rounds * len(arms)
assert len(positions) == len(arms)**2 and len(predecessors) == len(arms) * (len(arms)-1)
assert set(positions.values()) == set(predecessors.values()) == {rounds // len(arms)}
rank = max(i for i in range(rounds) if 2 * sum(comb(rounds, j) for j in range(i + 1)) / 2**rounds <= .05)

def values(v, history, indices, start="create-start", end="create-end"):
    return [sum(stages[r, v, history][i][end] - stages[r, v, history][i][start] for i in indices) for r in range(rounds)]

def interval(data):
    ordered = sorted(data)
    return median(data), ordered[rank], ordered[-rank-1]

def paired(a, b):
    return interval([x-y for x, y in zip(a, b, strict=True)])

for label, indices, start, end in [
    *((f"create {i+1}", [i], "create-start", "create-end") for i in [0, 1, 5, 10, 21]),
    ("create 1–24", range(calls), "create-start", "create-end"),
    ("first cleanup", [0], "c-end", "return"), ("first guest call", [0], "entry", "return"),
    ("guest calls 1–24", range(calls), "entry", "return"),
]:
    release = values("release", "normal", indices, start, end)
    print(label, "release", f"{median(release):.2f} ms")
    for v in ("bundled", "external"):
        normal = values(v, "normal", indices, start, end)
        for history in ["omit", "grouped"]:
            control = values(v, history, indices, start, end)
            delta = paired(normal, control)
            print(v, history, "normal/control", *(f"{median(arr):.2f}" for arr in [normal, control]),
                  "paired ms saved", *(f"{val:.2f}" for val in delta),
                  "paired fraction saved", round(median((x-y)/x for x,y in zip(normal,control)), 4))

# A smaller spike at a predetermined call can simply move to a neighboring
# invocation. Compare the worst creation time within each document first.
for v in ["bundled", "external"]:
    peaks = {}
    for history in ["normal", "omit", "grouped"]:
        columns = [values(v, history, [i]) for i in range(calls)]
        peaks[history] = [max(page) for page in zip(*columns, strict=True)]
    for history in ["omit", "grouped"]:
        print("worst creation per document", v, history,
              *(f"{median(peaks[h]):.2f}" for h in ["normal", history]),
              "paired ms saved", *(f"{x:.2f}" for x in paired(peaks["normal"], peaks[history])))

if args.plot:
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(1, 2, figsize=(9.5, 3.3), sharey=True, layout="constrained")
    for ax, v, title in zip(axes, ["bundled", "external"], ["Internal Oxc", "External runtime"], strict=True):
        for mode, history, label, color in [(v, "normal", "PR", "#007871"), (v, "omit", "Omit history", "#bc5028"),
                                            (v, "grouped", "Eight weak sets", "#7355a1"),
                                            ("release", "normal", "Jco 1.13.0", "#575d6a")]:
            vals = [median(values(mode, history, [i])) for i in range(calls)]
            ax.plot(range(1, calls + 1), vals, label=label, color=color, marker=".", lw=1.3)
        ax.set(title=title, xlabel="Guest invocation", xticks=[1, 6, 11, 16, 22, 24])
    axes[0].set_ylabel("Median row creation time (ms)")
    fig.legend(*axes[-1].get_legend_handles_labels(), loc="outside lower center", ncol=4, fontsize=8)
    fig.savefig(args.plot, dpi=170)
