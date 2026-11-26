"""Verify browser asset packaging and HTTP compression trials and report paired times."""
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

compression = data.get("study") == "--gzip"
application = data.get("study") in ("--app-bundle", "--single-entry")
assert compression or application or "study" not in data
suffix = {"--gzip":"-gzip", "--app-bundle":"-app", "--single-entry":"-app", None:"-inline"}[data.get("study")]
filename = "review-matrix-minified-db4a3aca0.json.gz" if compression or application else "review-matrix-minified-eaca992c8.json.gz"
matrix = bench / "results" / filename
assert digest(matrix) == data["matrixSha256"]
# The initial core-packaging study used the runner before it also supported preload hints.
runner_hash = digest(bench / "core-startup.mjs")
if application:
    archived = digest(args.input) == "47e8ebdc26bdc78349ccaa1ea87f72521aaa3f0bde6469e2baa761c65fd606d2"
    expected = "466960754fb757fcf1c9d427b20e81ca859813b16324d6acb560f59aed73888f" if archived else runner_hash
    assert data["runnerSha256"] == expected
    assert data["appBundlerSha256"] == digest(bench / "app-bundle.mjs")
    if data["study"] == "--single-entry":
        assert all(not imports for imports in data["appGraph"].values())
elif compression:
    expected = "1b7c6595f83094cf251228c11a9ba75c9231f6d8e073379d0f19536add75a640" if digest(args.input) == "935e5c7ae1d3e6fbe4777daaeef51de545e62e3a91e497d69312c381180fa73d" else runner_hash
    assert data["runnerSha256"] == expected
else:
    assert data["runnerSha256"] in (runner_hash, "f6d3f8fd18b1909c41291ce2c72a2c70d5a05f17738c341d68f4e41f9e81e6ef")
with gzip.open(matrix) as f:
    reference_run = json.load(f)
reference = reference_run["manifest"]
manifest = data["manifest"]
for path, meta in manifest.items():
    if path in data.get("appGraph", {}):
        continue
    if "-app/" in path:
        assert path.endswith(".core.wasm")
        path = path.replace("-app/", "/")
    if "-inline/" not in path:
        assert meta["sha256"] == reference[path]["sha256"] and meta["bytes"] == reference[path]["bytes"]

cases = [item["base"] for item in data["cases"]]
modes = data["modes"]
rounds = data["rounds"]
assert len(cases) == len(set(cases)) == 6 and len(set(modes)) == len(modes) == 6
assert rounds % 6 == 0 and rounds >= 6
expected_paths = {}
if compression or application:
    for sample in reference_run["samples"]:
        if sample["version"] in ("release", "bundled", "external") and sample["round"] == 0:
            key = (f"/{sample['lang']}/{sample['demo']}", sample["version"])
            expected_paths[key] = {q["path"] for q in sample["requests"]}
rows = {}
for row in data["samples"]:
    r, case, mode = key = tuple(row[k] for k in ("round","base","mode"))
    assert 0 <= r < rounds and case in cases and mode in modes and key not in rows
    assert row["firstMs"] > row["loadMs"] > 0
    paths = {req["path"] for req in row["requests"]}
    assert len(paths) == len(row["requests"])
    if compression or (application and not mode.endswith(suffix)):
        assert paths == expected_paths[case,mode.removesuffix(suffix)]
    size_key = "gzip" if compression and mode.endswith(suffix) else "bytes"
    for req in row["requests"]:
        asset = manifest[req["path"]]
        assert req["bytes"] == asset[size_key] and req["transferred"] > 0
        if compression:
            assert req["decoded"] == asset["bytes"]
    assert sum(path.endswith(".wasm") for path in paths) == int(not mode.endswith("-inline"))
    assert any(path.startswith("/runtime/") for path in paths) == (mode.startswith("external") and not mode.endswith("-app"))
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
            trial_paths = {req["path"].replace("-inline/", "/") for req in rows[r,case["base"],build+suffix]["requests"]}
            assert key in base_paths
            if application:
                entry = key.removesuffix(".core.wasm").replace("/"+build+"/","/"+build+suffix+"/")+".js"
                reachable, queue = set(), [entry]
                while queue:
                    path = queue.pop()
                    if path not in reachable:
                        reachable.add(path)
                        queue.extend(data["appGraph"][path])
                assert trial_paths == reachable | {entry.removesuffix(".js")+".core.wasm"}
            elif compression:
                assert trial_paths == base_paths
            else:
                assert trial_paths == base_paths - {key}
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
        if field == "jsRequests":
            return sum(p["path"].endswith(".js") for p in row["requests"])
        if field == "jsBytes":
            return sum(p["bytes"] for p in row["requests"] if p["path"].endswith(".js"))
        if field == "bodyBytes":
            return sum(p["bytes"] for p in row["requests"])
        if field in ("bytes","gzip"):
            return sum(manifest[p["path"]][field] for p in row["requests"])
        return row[field]
    return [value(rows[r,case,mode]) for r in range(rounds)]

def paired(case, mode, field):
    return [b/a for a,b in zip(values(case,mode,field), values(case,mode+suffix,field))]

def summarize(mode, field):
    return median(median(values(case,mode,field)) for case in cases)

def typical_ratio(mode, field):
    return median(median(paired(case, mode, field)) for case in cases)

if application:
    print("| Build | Import ms, original → app | First result ms, original → app | Paired first result | JS requests, original → app | JS KiB, original → app |")
    print("| --- | ---: | ---: | ---: | ---: | ---: |")
elif compression:
    print("| Build | Import ms, plain → gzip | First result ms, plain → gzip | Paired first result | JS + Wasm body KiB, plain → gzip |")
    print("| --- | ---: | ---: | ---: | ---: |")
else:
    print("| Build | Import ms, fetched → embedded | First result ms, fetched → embedded | Paired first result | All JS + Wasm KiB, fetched → embedded | Gzip estimate KiB, fetched → embedded |")
    print("| --- | ---: | ---: | ---: | ---: | ---: |")
labels = {"release":"Jco 1.13.0", "bundled":"Internal Oxc", "external":"External runtime"}
for mode, name in labels.items():
    def both(key, scale=1):
        return " → ".join(f"{summarize(m,key)/scale:.2f}" for m in (mode,mode+suffix))
    sizes = both("bodyBytes",1024) if compression else f"{both('bytes',1024)} | {both('gzip',1024)}"
    if application:
        sizes = f"{both('jsRequests')} | {both('jsBytes',1024)}"
    print(f"| {name} | {both('loadMs')} | {both('firstMs')} | {typical_ratio(mode,'firstMs'):.3f}× | {sizes} |")

if application:
    # Distinct URLs measure the JS a cache could reuse across all six components.
    # Rows time one cold guest each, so this is a size calculation only.
    print("\n| Build | All six original entries, distinct JS KiB | All six application entries, distinct JS KiB |")
    print("| --- | ---: | ---: |")
    for mode, name in labels.items():
        totals = []
        for layout in (mode, mode + suffix):
            urls = {req["path"] for case in cases for req in rows[0,case,layout]["requests"]
                    if req["path"].endswith(".js")}
            totals.append(sum(manifest[url]["bytes"] for url in urls) / 1024)
        print(f"| {name} | {totals[0]:.2f} | {totals[1]:.2f} |")

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
    comparison = {"--gzip":"gzip / uncompressed", "--app-bundle":"application build / original", "--single-entry":"single-entry build / original", None:"embedded / fetched"}[data.get("study")]
    ax.set_xlabel("Time to first result, "+comparison)
    fig.legend(*ax.get_legend_handles_labels(),loc="outside lower center",ncol=3)
    fig.savefig(args.plot,dpi=150)
