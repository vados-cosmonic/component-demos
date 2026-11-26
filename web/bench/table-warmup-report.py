"""Compare Rust table creation at the same guest invocation in each browser round."""

import argparse
from collections import Counter
import gzip
from hashlib import sha256
import json
from math import comb
from pathlib import Path
from statistics import median

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("samples", type=Path)
parser.add_argument("matrix", type=Path)
parser.add_argument("--plot", type=Path)
parser.add_argument("--spans", type=Path, help="foreground trace intervals from this run")
args = parser.parse_args()


def read_archive(path):
    with gzip.open(path) as stream:
        return json.load(stream)


def digest(path):
    return sha256(path.read_bytes()).hexdigest()


run = read_archive(args.samples)
matrix = read_archive(args.matrix)
versions = ["release", "bundled", "external"]
warmups = ["none", "js", "guest"]
rounds, calls, rows = run["rounds"], run["calls"], run["rows"]
assert (rounds, calls) == (18, 24)
assert run["versions"] == versions and run["warmups"] == warmups
assert run["matrixSha256"] == digest(args.matrix)
assert run["runnerSha256"] == digest(Path(__file__).with_name("table-warmup.mjs"))
assert run["revision"] == matrix["candidate"] and rows == matrix["workloads"]["table-update"]["rows"]
paths = {
    s["version"]: sorted(q["path"] for q in s["requests"])
    for s in matrix["samples"]
    if s["round"] == 0 and s["lang"] == "rust" and s["demo"] == "table-update" and s["version"] in versions
}
assert sorted(a["version"] for a in run["audits"]) == sorted(versions)
for audit in run["audits"]:
    assert audit["counts"] == {"createElement": 2 * rows, "setTextContent": rows, "appendChild": 2 * rows}
    assert audit["requests"] == paths[audit["version"]]

samples = {}
positions, predecessors = Counter(), Counter()
for r in range(rounds):
    group = sorted((s for s in run["samples"] if s["round"] == r), key=lambda s: s["position"])
    assert [s["position"] for s in group] == list(range(9))
    order = [(s["version"], s["warmup"]) for s in group]
    assert set(order) == {(v, w) for v in versions for w in warmups}
    positions.update(enumerate(order))
    predecessors.update(zip(order, order[1:]))
    for s in group:
        assert s["requests"] == paths[s["version"]] and len(s["measurements"]) == calls
        assert all(len(m) == 6 and min(m.values()) > 0 for m in s["measurements"])
        samples[r, s["version"], s["warmup"]] = s
assert len(samples) == len(run["samples"]) == rounds * 9
assert len(positions) == 81 and set(positions.values()) == {2}
assert len(predecessors) == 72 and set(predecessors.values()) == {2}

# Exact two-sided sign interval for the paired median at one invocation.
rank = max(i for i in range(rounds) if 2 * sum(comb(rounds, j) for j in range(i + 1)) / 2**rounds <= .05)


def times(version, warmup, i):
    # The demo parser returns seconds even though its metric name ends in "ms".
    return [1000 * samples[r, version, warmup]["measurements"][i]["create: total ms"] for r in range(rounds)]


def ratio(candidate, reference):
    paired = sorted(x / y for x, y in zip(candidate, reference, strict=True))
    return median(paired), paired[rank], paired[-rank - 1]


print("Prior work, guest call, release/internal/external ms, paired internal/external ratios with 95% intervals")
for w in warmups:
    offset = 4 if w == "guest" else 0
    for i in range(calls):
        values = [times(v, w, i) for v in versions]
        ratios = [ratio(x, values[0]) for x in values[1:]]
        print(w, i + offset + 1, *(f"{median(x):.2f}" for x in values),
              *(f"{mid:.3f}× ({lo:.3f}–{hi:.3f})" for mid, lo, hi in ratios))

if run["timeWeakAdds"]:
    print("Median longest WeakSet.add in the creation phase, release/internal/external ms")
    for s in samples.values():
        assert len(s["weakAdds"]) == calls
        for stat in s["weakAdds"]:
            assert stat["count"] == (0 if s["version"] == "release" else 2 * rows + 1)
            assert 0 <= stat["longestMs"] <= stat["totalMs"]
    for w in warmups:
        for invocation in [6, 11, 21, 22, 23]:
            i = invocation - (4 if w == "guest" else 0) - 1
            print(w, invocation, *(round(median(samples[r, v, w]["weakAdds"][i]["longestMs"]
                                                for r in range(rounds)), 3) for v in versions))


def overlap_ms(events, kind):
    # Clipped spans share one time origin. Count nested compiler events once.
    total = end = 0
    for a, b in sorted((a, b) for k, _, a, b in events if k == kind):
        total += max(0, b - max(end, a))
        end = max(end, b)
    return total / 1000


if args.spans:
    trace = read_archive(args.spans)
    assert run["traced"] and trace["samplesSha256"] == digest(args.samples)
    spans = {(s["round"], s["version"], s["warmup"], s["call"]): s for s in trace["spans"]}
    assert len(spans) == len(trace["spans"]) == len(samples) * calls
    for (r, v, w), s in samples.items():
        for i, m in enumerate(s["measurements"]):
            span = spans[r, v, w, i]
            assert span["position"] == s["position"]
            assert abs(span["markMs"] - 1000 * m["create: total ms"]) < .012
            assert all(0 <= a < b <= span["spanUs"] for _, _, a, b in span["events"])
    print("Median foreground GC and compiler overlap in milliseconds on actual guest call 22")
    for w in warmups:
        for v in versions:
            events = [spans[r, v, w, 17 if w == "guest" else 21]["events"] for r in range(rounds)]
            print(w, v, *(median(overlap_ms(e, kind) for e in events) for kind in ["gc", "compile"]))

if args.plot:
    import matplotlib.pyplot as plt

    assert not run["traced"] and not run["timeWeakAdds"]
    labels = {"none": "No prior calls", "js": "Four prior JS calls", "guest": "Four prior guest calls"}
    fig, axes = plt.subplots(1, 3, figsize=(11, 3.4), sharex=True, sharey=True, layout="constrained")
    for ax, w in zip(axes, warmups, strict=True):
        invocations = range(5, 29) if w == "guest" else range(1, 25)
        for v, label, color, marker in [("bundled", "Internal Oxc", "#00796b", "o"),
                                        ("external", "External runtime", "#aa4726", "s")]:
            mid, lo, hi = zip(*(ratio(times(v, w, i), times("release", w, i)) for i in range(calls)))
            ax.fill_between(invocations, lo, hi, color=color, alpha=.1)
            ax.plot(invocations, mid, color=color, lw=1.3, marker=marker, ms=3, label=label)
        ax.axhline(1, color="#555", ls="--", lw=1)
        ax.set_title(labels[w])
        ax.set_xticks([1, 6, 11, 16, 22, 28])
        ax.set_xlabel("Guest invocation")
    axes[0].set_ylabel("Creation time / Jco 1.13.0")
    axes[-1].legend(loc="upper right", fontsize=8)
    fig.savefig(args.plot, dpi=160)
