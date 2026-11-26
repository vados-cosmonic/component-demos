"""Align Chrome renderer-thread trace intervals with each measured Rust create phase."""

import argparse
from collections import defaultdict
import gzip
from hashlib import sha256
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("samples", type=Path)
parser.add_argument("traces", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
with gzip.open(args.samples) as stream:
    run = json.load(stream)
assert run["traced"]
spans = []
trace_hashes = []
for r in range(run["rounds"]):
    raw = (args.traces / f"round-{r}.json").read_bytes()
    trace_hashes.append(sha256(raw).hexdigest())
    events = json.loads(raw)["traceEvents"]
    pages = defaultdict(list)
    by_thread = defaultdict(list)
    for e in events:
        name = e["name"]
        if e["ph"] == "I" and name in {"create-start", "create-end"} and "blink.user_timing" in e["cat"]:
            pages[e["args"]["data"]["navigationId"]].append(e)
        elif e["ph"] == "X" and e.get("dur", 0) > 0:
            # Use Chrome's outer GC events. Compiler events may be nested; keep
            # their names and count their interval union in the report.
            if name in {"MinorGC", "MajorGC"}:
                kind = "gc"
            elif "disabled-by-default-v8.compile" in e["cat"] and (
                name.startswith("V8.") or name == "FlushInstructionCache"
            ):
                kind = "compile"
            else:
                continue
            by_thread[e["pid"], e["tid"]].append((e["ts"], e["ts"] + e["dur"], kind, name))
    pages = sorted((sorted(p, key=lambda e: e["ts"]) for p in pages.values()), key=lambda p: p[0]["ts"])
    trials = sorted((s for s in run["samples"] if s["round"] == r), key=lambda s: s["position"])
    assert len(pages) == len(trials) + (len(run["audits"]) if r == run["rounds"] - 1 else 0)
    for trial, marks in zip(trials, pages):
        expected_calls = run["calls"] + (0 if trial["warmup"] == "none" else 4)
        assert [m["name"] for m in marks] == ["create-start", "create-end"] * expected_calls
        for call, measured in enumerate(trial["measurements"]):
            start_index = 2 * (expected_calls - run["calls"] + call)
            start, end = marks[start_index:start_index + 2]
            thread = start["pid"], start["tid"]
            assert thread == (end["pid"], end["tid"])
            a, b = start["ts"], end["ts"]
            assert a < b
            # The guest publishes milliseconds to three decimal places. The
            # shared demo parser returns seconds. Match the actual mark values.
            mark_ms = end["args"]["data"]["startTime"] - start["args"]["data"]["startTime"]
            assert abs(mark_ms - 1000 * measured["create: total ms"]) < .012
            overlap = [
                [kind, name, max(a, x) - a, min(b, y) - a]
                for x, y, kind, name in by_thread[thread] if x < b and y > a
            ]
            spans.append({
                "round": r,
                "position": trial["position"],
                "call": call,
                "version": trial["version"],
                "warmup": trial["warmup"],
                "spanUs": b - a,
                "markMs": mark_ms,
                "events": overlap,
            })
with gzip.open(args.output, "wt") as stream:
    json.dump({
        "samplesSha256": sha256(args.samples.read_bytes()).hexdigest(),
        "traceSha256": trace_hashes,
        "spans": spans,
    }, stream, separators=(",", ":"))
