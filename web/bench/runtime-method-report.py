"""Verify the size and coverage archives and reproduce the README's counts."""

import argparse
import gzip
import hashlib
import json
from pathlib import Path
from statistics import median


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path):
    with gzip.open(path, "rt") as stream:
        return json.load(stream)


parser = argparse.ArgumentParser(description=__doc__)
for name in ("matrix", "classes", "host_calls"):
    parser.add_argument(name, type=Path)
args = parser.parse_args()
matrix, classes, host = map(load, (args.matrix, args.classes, args.host_calls))
here = Path(__file__).parent
for archive, runner in [(classes, "runtime-class-methods.mjs"), (host, "host-call-shape.mjs")]:
    assert archive["runnerSha256"] == digest(here / runner)
    assert archive["matrixSha256"] == digest(args.matrix)
    assert archive["candidate"] == matrix["candidate"]
assert classes["chromium"] == matrix["chromium"]

for mode in ("bundled", "external"):
    samples = {f"{s['lang']}/{s['demo']}": s for s in matrix["samples"]
               if s["version"] == mode and s["round"] == 0}
    documents = [row for row in classes["observations"] if row["mode"] == mode]
    calls = [row for row in host["rows"] if row["mode"] == mode]
    assert len(samples) == len(documents) == len(calls) == 21
    assert samples.keys() == {f"{r['lang']}/{r['demo']}" for r in documents}
    assert samples.keys() == {r["name"] for r in calls}
    print(mode)
    for kind, zeros in classes["zeroMethods"][mode].items():
        seen = {stage: set() for stage in ("import", "guest", "stop")}
        all_names = set()
        for row in documents:
            assert row["checkpoints"].keys() == seen.keys()
            definitions = [cls for path in row["paths"] for cls in classes["inventories"][path]
                           if cls["kind"] == kind]
            assert len(definitions) == 1
            declared = {m["name"] for m in definitions[0]["methods"]}
            for stage, names in seen.items():
                hits = row["checkpoints"][stage][kind]
                assert hits.keys() <= declared
                assert all(isinstance(n, int) and n >= 0 for n in hits.values())
                names.update(name for name, count in hits.items() if count)
            for name in zeros:
                counts = [stage[kind][name] for stage in row["checkpoints"].values()
                          if name in stage[kind]]
                assert counts and all(count == 0 for count in counts)
            all_names.update(declared)
        called = set.union(*seen.values())
        assert called.isdisjoint(zeros) and all_names == called.union(zeros)
        print(kind, "declared/import/guest/stop/distinct/zero:",
              len(all_names), *(len(names) for names in seen.values()), len(called), len(zeros))
        only_stop = seen["stop"] - seen["guest"] - seen["import"]
        if only_stop:
            print("shutdown only:", ", ".join(sorted(only_stop)))
    sizes = []
    for row in documents:
        scripts = [classes["footprints"][path] for path in row["paths"]]
        assert sum(s["explicitZeros"] for s in scripts) == sum(map(len, classes["zeroMethods"][mode].values()))
        sizes.append([sum(s["original"][i] - s["emptyBodies"][i] for s in scripts) for i in range(2)])
    print("class body bytes removed, raw/Brotli:", *map(median, zip(*sizes)))
    for row in calls:
        entry = samples[row["name"]]["entry"]
        assert row["original"]["sha256"] == matrix["manifest"][entry]["sha256"]
    print("outlined calls:", sum(s["sites"] for s in calls), "median bytes saved, raw/gzip/Brotli:",
          *(median(s["original"][k] - s["outlined"][k] for s in calls)
            for k in ("bytes", "gzip", "brotli")))
