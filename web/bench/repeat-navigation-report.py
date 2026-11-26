"""Summarize paired first and repeat visits across independent Chromium processes."""
import argparse
from collections import Counter
import gzip
import hashlib
import json
from math import comb
from pathlib import Path
from statistics import median

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("archive", type=Path)
parser.add_argument("matrix", type=Path)
parser.add_argument("--plot", type=Path)
args = parser.parse_args()
data = json.loads(gzip.decompress(args.archive.read_bytes()))
matrix_bytes = args.matrix.read_bytes()
matrix = json.loads(gzip.decompress(matrix_bytes))
assert data["matrixSha256"] == hashlib.sha256(matrix_bytes).hexdigest()
assert data["runnerSha256"] == hashlib.sha256(Path(__file__).with_name("repeat-navigation.mjs").read_bytes()).hexdigest()
for field in ("release", "upstream", "candidate"):
    assert data[field] == matrix[field]

versions, policies = data["versions"], data["policies"]
assert versions == ["release", "main", "bundled", "external"]
assert policies == ["neither", "js", "wasm", "both"]
rounds = range(data["rounds"])
cases = sorted({row["base"] for row in data["samples"]})
assert len(rounds) == 16 and len(cases) == 6
rows = {}
ids = set()
expected = {(f"/{r['lang']}/{r['demo']}", r["version"]): sorted(q["path"] for q in r["requests"])
            for r in matrix["samples"] if r["round"] == 0}
for row in data["samples"]:
    key = row["round"], row["base"], row["version"], row["policy"], row["visit"]
    assert key not in rows and row["documentId"] not in ids
    rows[key] = row
    ids.add(row["documentId"])
    requests = row["requests"]
    paths = expected[row["base"], row["version"]]
    assert sorted(q["path"] for q in requests) == paths
    assert sorted(q["path"] for q in requests if q["transferred"]) == sorted(row["network"])
    assert len(set(row["network"])) == len(row["network"])
    if row["visit"] == 1 or row["policy"] == "neither":
        assert sorted(row["network"]) == paths
    for path in paths:
        size = matrix["manifest"][path]["bytes"]
        if path in row["network"]:
            assert next(q["encoded"] for q in requests if q["path"] == path) == size
assert len(rows) == len(rounds)*len(cases)*len(versions)*len(policies)*2
for case in cases:
    positions, predecessors = Counter(), Counter()
    for r in rounds:
        order = sorted((rows[r,case,v,p,1]["pos"],v,p) for v in versions for p in policies)
        assert list(o[0] for o in order) == list(range(16))
        for pos,v,p in order:
            assert rows[r,case,v,p,2]["pos"] == pos
            positions[pos,v,p] += 1
        predecessors.update((a[1:],b[1:]) for a,b in zip(order,order[1:]))
    assert len(positions) == 16**2 and set(positions.values()) == {1}
    assert len(predecessors) == 16*15 and set(predecessors.values()) == {1}

def summarize(values):
    # One median across the six workloads per browser. Independent browsers,
    # rather than repeated navigations within a process, determine the bounds.
    values = sorted(values)
    n = len(values)
    rank = max(k for k in range(n) if 2*sum(comb(n,j) for j in range(k+1)) <= .05*2**n)
    return median(values), values[rank], values[-rank-1]

def timing(version, policy, metric, visit=2):
    return median(median(rows[r,c,version,policy,visit][metric] for c in cases) for r in rounds)

def ratio(version, policy, baseline, baseline_policy, metric):
    return summarize(median(rows[r,c,version,policy,2][metric] / rows[r,c,baseline,baseline_policy,2][metric]
                            for c in cases) for r in rounds)

labels = {"release":"Jco 1.13.0", "main":"Upstream main", "bundled":"Internal Oxc", "external":"External checked"}
# Use the full-size workloads to locate the original gap. Subtract on each
# document before comparing matched browser rounds; medians do not add.
full = {(r["lang"],r["demo"],r["version"],r["round"]):r for r in matrix["samples"]}
full_cases = sorted({(r["lang"],r["demo"]) for r in matrix["samples"] if r["version"]=="release"})
def full_delta(version, case, field):
    def value(row):
        return row["loadMs"] if field=="import" else row["firstResultMs"]-row["loadMs"]
    return median(value(full[case + (version,r)])-value(full[case + ("release",r)]) for r in range(matrix["rounds"]))

print("Full demo matrix, paired excess milliseconds over Jco 1.13.0")
for v in versions[1:]:
    for field in ["import","first guest"]:
        deltas = [full_delta(v, case, field) for case in full_cases]
        print(labels[v],field, f"{median(deltas):+.2f} ms; slower in {sum(t>0 for t in deltas)}/{len(deltas)} cases")
print()
print("| Build | First result on first visit¹ (ms) | Repeat, neither cached | Repeat, JS cached | Repeat, Wasm cached | Repeat, both cached | Both / neither on repeat (95% interval) |")
print("| --- | ---: | ---: | ---: | ---: | ---: | ---: |")
for v in versions:
    times = [timing(v,"neither","firstMs",visit=1)] + [timing(v,p,"firstMs") for p in policies]
    mid,lo,hi = ratio(v,"both",v,"neither","firstMs")
    print("|", labels[v], "|", " | ".join(f"{t:.2f}" for t in times), f"| {mid:.3f}× ({lo:.3f}–{hi:.3f}) |")
print("¹ First visit uses the no-store control. All repeat times are milliseconds.")
print("\n| Build | Repeat import (ms), neither → both | Repeat first result / fully cached release, individual 95% interval |")
print("| --- | ---: | ---: |")
for v in versions:
    mid,lo,hi = ratio(v,"both","release","both","firstMs")
    print(f"| {labels[v]} | {timing(v,'neither','loadMs'):.2f} → {timing(v,'both','loadMs'):.2f} | {mid:.3f}× ({lo:.3f}–{hi:.3f}) |")
print("\nRepeat visits with zero JS/Wasm asset responses, per policy")
for p in policies:
    selected = [row for row in rows.values() if row["policy"]==p and row["visit"]==2]
    print(p, sum(not row["network"] for row in selected), "/", len(selected))
    print("Network JS and Wasm responses", *(sum(path.endswith(ext) for row in selected for path in row["network"]) for ext in (".js",".wasm")))

if args.plot:
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(8.6, 4.2), layout="constrained")
    for i,(policy,color) in enumerate(zip(policies[1:], ["#006c65","#ba541a","#3a5489"])):
        for j,version in enumerate(versions):
            mid,lo,hi = ratio(version,policy,version,"neither","firstMs")
            ax.errorbar(mid,j+(i-1)*.19,xerr=[[mid-lo],[hi-mid]],fmt="o",capsize=3,color=color,
                        label={"js":"JS cached","wasm":"Wasm cached","both":"Both cached"}[policy] if j==0 else None)
    ax.axvline(1, color="#555", linewidth=1)
    ax.set_yticks(range(4), [labels[v] for v in versions])
    ax.invert_yaxis()
    ax.set_xlabel("Repeat-visit first-result time / no-store repeat (lower is faster)")
    ax.grid(axis="x",alpha=.2)
    fig.legend(*ax.get_legend_handles_labels(),loc="outside lower center",ncol=3)
    fig.savefig(args.plot,dpi=160)
