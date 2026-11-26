"""Verify deferred trap-map trials and report paired instantiation and heap changes."""
import argparse
import gzip
import hashlib
import json
from collections import Counter
from pathlib import Path
from statistics import median

from sign_interval import median_sign_index


def load(path):
    return json.loads(gzip.decompress(path.read_bytes()))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def interval(observations):
    values = sorted(observations)
    rank = median_sign_index(len(values))
    return f"{median(values):.3f} ({values[rank]:.3f}–{values[-1-rank]:.3f})"


parser = argparse.ArgumentParser(description=__doc__)
for name in ("matrix", "reference", "timing", "timing_runner", "heap", "heap_runner"):
    parser.add_argument(name, type=Path)
args = parser.parse_args()
matrix, reference = load(args.matrix), load(args.reference)
languages = ["c", "cpp", "rust"]
builds = ["bundled", "external"]
strategies = ["default", "lazy"]
for label, archive, runner in (("timing", args.timing, args.timing_runner),
                               ("heap", args.heap, args.heap_runner)):
    run = load(archive)
    assert run["chromium"] == matrix["chromium"] == reference["chromium"]
    assert run["matrix"] == reference["matrix"] == digest(args.matrix)
    assert run["revision"] == matrix["candidate"] and run["runner"] == digest(runner)
    assert run["batchSize"] == 8 and run["rounds"] == 20 and not run["traced"]
    assert run["files"] == reference["files"] and run["guests"] == reference["guests"]
    extra = set(run["manifest"]) - set(reference["manifest"])
    assert extra == {f"/{lang}/{build}/lazy.js" for build in builds for lang in languages}
    for path, asset in reference["manifest"].items():
        assert run["manifest"][path] == asset
    if label == "timing":
        candidate_assets = {path: run["manifest"][path] for path in extra}
    else:
        assert candidate_assets == {path: run["manifest"][path] for path in extra}
    rows, positions = {}, Counter()
    for row in run["samples"]:
        r, lang, build, strategy = (row[k] for k in ("round", "lang", "build", "strategy"))
        key = (r, lang, build, strategy)
        assert key not in rows and r in range(20) and lang in languages and build in builds and strategy in strategies
        rows[key] = row
        positions[(lang, build, strategy, row["pos"])] += 1
        assert row["trapMaps"] == ([0, 1] if strategy == "lazy" else [1, 1])
        assert row["firstMs"] > 0 and len(row["batches"]) == 6 and min(row["batches"]) > 0
        assert sorted(record["name"] for record in row["calls"]) == sorted(run["files"][f"/{lang}/{build}/"])
        assert row["measurements"] == sorted(f"{phase}: {metric}" for phase in
            ("create", "update (selected)", "clear (unselected)") for metric in ("total ms", "µs/row"))
        if label == "heap":
            assert len(row["heap"]) == 3 and row["heap"][2] > row["heap"][1]
    assert len(rows) == 240 and len(positions) == 48 and set(positions.values()) == {5}
    for build in builds:
        for metric in ("first", "repeated", "retained"):
            if metric == "retained" and label != "heap":
                continue
            def value(row):
                if metric == "first":
                    return row["firstMs"]
                if metric == "repeated":
                    return median(row["batches"][1:])
                # The page holds eight and then 32 complete guest instances
                # across forced collections. This slope excludes fixed costs.
                return (row["heap"][2] - row["heap"][1]) / 24
            if metric == "retained":
                baseline = [value(row) for row in rows.values()
                            if row["build"] == build and row["strategy"] == "default"]
                print(build, "shipping median retained JS heap bytes per instance", median(baseline))
            paired = []
            for r in range(20):
                by_language = []
                for lang in languages:
                    trial = value(rows[r, lang, build, "lazy"])
                    control = value(rows[r, lang, build, "default"])
                    by_language.append(trial - control if metric == "retained" else trial / control)
                paired.append(median(by_language))
            unit = "extra JS heap bytes per instance" if metric == "retained" else "trial / control"
            print(label, build, metric, unit, interval(paired))
