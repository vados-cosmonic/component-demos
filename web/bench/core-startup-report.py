"""Verify the core-packaging comparison and summarize the paired browser times."""
import argparse
from collections import Counter
import gzip
from hashlib import sha256
import json
from math import comb
from pathlib import Path
from statistics import median

bench = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("input", nargs="?", type=Path, default=bench / "results/core-startup.json.gz")
parser.add_argument("--plot", type=Path)
args = parser.parse_args()
with gzip.open(args.input) as f:
    data = json.load(f)

def digest(path):
    return sha256(path.read_bytes()).hexdigest()

matrix = bench / "results/review-matrix-minified-eaca992c8.json.gz"
assert digest(matrix) == data["matrixSha256"]
assert digest(bench / "core-startup.mjs") == data["runnerSha256"]
with gzip.open(matrix) as f:
    reference = json.load(f)["manifest"]
manifest = data["manifest"]
for path, meta in manifest.items():
    if "-inline/" not in path:
        assert meta["sha256"] == reference[path]["sha256"] and meta["bytes"] == reference[path]["bytes"]

cases = [item["base"] for item in data["cases"]]
modes = data["modes"]
rounds = data["rounds"]
assert len(cases) == len(set(cases)) == 6 and len(set(modes)) == len(modes) == 6
assert rounds % 6 == 0 and rounds >= 6
rows = {}
for row in data["samples"]:
    r, case, mode = key = tuple(row[k] for k in ("round","base","mode"))
    assert 0 <= r < rounds and case in cases and mode in modes and key not in rows
    assert row["firstMs"] > row["loadMs"] > 0
    paths = {req["path"] for req in row["requests"]}
    assert len(paths) == len(row["requests"])
    assert all(req["bytes"] == manifest[req["path"]]["bytes"] and req["transferred"] > 0 for req in row["requests"])
    assert sum(path.endswith(".wasm") for path in paths) == int(not mode.endswith("-inline"))
    assert any(path.startswith("/runtime/") for path in paths) == mode.startswith("external")
    rows[key] = row
assert len(rows) == rounds * len(cases) * len(modes)
for case in data["cases"]:
    name = case["name"]
    core_hashes = set()
    for build in ["release","bundled","external"]:
        key = case["base"] + "/" + build + "/" + name + ".core.wasm"
        core_hashes.add(manifest[key]["sha256"])
        for r in range(rounds):
            base_paths = {req["path"] for req in rows[r,case["base"],build]["requests"]}
            inline_paths = {req["path"].replace("-inline/", "/") for req in rows[r,case["base"],build+"-inline"]["requests"]}
            assert base_paths - {key} == inline_paths and key in base_paths
    assert len(core_hashes) == 1
for start in range(0, rounds, 6):
    for case in cases:
        positions, pairs = Counter(), Counter()
        for r in range(start, start+6):
            order = sorted(modes, key=lambda m: rows[r,case,m]["cursor"])
            positions.update(enumerate(order))
            pairs.update(zip(order, order[1:]))
        assert len(positions) == 36 and set(positions.values()) == {1}
        assert len(pairs) == 30 and set(pairs.values()) == {1}

def values(case, mode, field):
    def value(row):
        if field in ("bytes","gzip"):
            return sum(manifest[p["path"]][field] for p in row["requests"])
        return row[field]
    return [value(rows[r,case,mode]) for r in range(rounds)]

def paired(case, mode, field):
    return [b/a for a,b in zip(values(case,mode,field), values(case,mode+"-inline",field))]

def summarize(mode, field):
    return median(median(values(case,mode,field)) for case in cases)

def typical_ratio(mode, field):
    return median(median(paired(case, mode, field)) for case in cases)

print("| Build | Import ms, fetched → embedded | First result ms, fetched → embedded | Paired first result | All JS + Wasm KiB, fetched → embedded | Gzip estimate KiB, fetched → embedded |")
print("| --- | ---: | ---: | ---: | ---: | ---: |")
labels = {"release":"Jco 1.13.0", "bundled":"Internal Oxc", "external":"External runtime"}
for mode, name in labels.items():
    def both(key, scale=1):
        return " → ".join(f"{summarize(m,key)/scale:.2f}" for m in (mode,mode+"-inline"))
    print(f"| {name} | {both('loadMs')} | {both('firstMs')} | {typical_ratio(mode,'firstMs'):.3f}× | {both('bytes',1024)} | {both('gzip',1024)} |")

rank = max(i for i in range(rounds) if 2*sum(comb(rounds,j) for j in range(i+1))/2**rounds <= .05)
def interval(case, mode):
    times = sorted(paired(case,mode,"firstMs"))
    return median(times), times[rank], times[-1-rank]
case_names = {"c":"C","cpp":"C++","rust":"Rust"}
def label(case):
    _, lang, demo = case.split("/")
    return case_names[lang] + " " + {"dom-query":"DOM query","table-update":"table update"}[demo]
print("\n| Guest and workload | 1.13.0 | Internal Oxc | External runtime |")
print("| --- | ---: | ---: | ---: |")
for case in cases:
    fields = ["%.2f× (%.2f–%.2f)" % interval(case,mode) for mode in labels]
    print("|", label(case), "|", " | ".join(fields), "|")

if args.plot:
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(7,4.4),layout="constrained")
    for (mode, name), offset, fmt, color in zip(labels.items(), [-.21,0,.21], ["s","o","x"], ["#626978","#00796B","#AD4524"]):
        for i, case in enumerate(cases):
            mid, lo, hi = interval(case,mode)
            ax.errorbar(mid,i+offset,xerr=[[mid-lo],[hi-mid]],fmt=fmt,color=color,capsize=2,label=name if i==0 else None)
    ax.axvline(1,color="#555",lw=1)
    ax.set_yticks(range(len(cases)), [label(c) for c in cases])
    ax.invert_yaxis()
    ax.grid(axis="x",alpha=.2)
    ax.set_xlabel("Time to first result, embedded / fetched")
    fig.legend(*ax.get_legend_handles_labels(),loc="outside lower center",ncol=3)
    fig.savefig(args.plot,dpi=150)
