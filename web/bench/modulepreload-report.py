"""Verify equal transfers across runtime preload layouts and summarize cold startup."""
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
parser.add_argument("input", nargs="?", type=Path, default=bench / "results/modulepreload.json.gz")
parser.add_argument("--plot", type=Path)
args = parser.parse_args()
with gzip.open(args.input) as f:
    data = json.load(f)
matrix_file = bench / "results/review-matrix-minified-db4a3aca0.json.gz"
assert data["study"] == "--modulepreload"
assert data["matrixSha256"] == sha256(matrix_file.read_bytes()).hexdigest()
assert data["runnerSha256"] == sha256((bench / "core-startup.mjs").read_bytes()).hexdigest()
with gzip.open(matrix_file) as f:
    reference = json.load(f)
assert data["release"] == "1.13.0"
for path, meta in data["manifest"].items():
    assert (meta["sha256"], meta["bytes"]) == (reference["manifest"][path]["sha256"],reference["manifest"][path]["bytes"])
modes = ["release", "bundled", "external", "direct", "transitive", "all"]
assert data["modes"] == modes
cases = {c["base"]: c for c in data["cases"]}
assert set(cases) == {f"/{lang}/{demo}" for lang in ("c","cpp","rust") for demo in ("dom-query","table-update")}
rounds = data["rounds"]
assert rounds >= 6 and rounds % 6 == 0
rows = {}
for row in data["samples"]:
    case, delay, mode, r = key = tuple(row[k] for k in ("base","delay","mode","round"))
    assert case in cases and delay in (0,10) and mode in modes and 0 <= r < rounds and key not in rows
    assert row["firstMs"] > row["loadMs"] > 0
    build = mode if mode in modes[:3] else "external"
    entry = case + "/" + build + "/" + cases[case]["name"]
    hints = data["hintLists"][case]
    assert set(hints["direct"]).isdisjoint(hints["transitive"])
    assert set(hints["all"]) == set(hints["direct"]) | set(hints["transitive"])
    expected = {entry+".js", entry+".core.wasm"}
    if build == "external":
        expected.update(hints["all"])
    by_path = {q["path"]: q for q in row["requests"]}
    assert expected == set(by_path) and len(expected) == len(row["requests"])
    for p,q in by_path.items():
        assert q["bytes"] == data["manifest"][p]["bytes"] and q["transferred"] > 0
        assert -.02 <= q["startMs"] <= q["endMs"] <= row["firstMs"]+.02
    rows[key] = row
assert len(rows) == len(cases)*2*len(modes)*rounds
for case in cases:
    for delay in (0,10):
        for start in range(0,rounds,6):
            positions, adjacent = Counter(), Counter()
            for r in range(start,start+6):
                order = sorted(modes, key=lambda m: rows[case,delay,m,r]["cursor"])
                positions.update(enumerate(order))
                adjacent.update(zip(order,order[1:]))
            assert len(positions) == 36 and set(positions.values()) == {1}
            assert len(adjacent) == 30 and set(adjacent.values()) == {1}

def values(case, delay, mode, field):
    result = []
    for r in range(rounds):
        row = rows[case,delay,mode,r]
        if field in ("startMs","endMs"):
            result.append(max(q[field] for q in row["requests"] if q["path"].startswith("/runtime/")))
        else:
            result.append(row[field])
    return result

def typical(delay, mode, field):
    return median(median(values(c,delay,mode,field)) for c in cases)

rank = max(i for i in range(rounds) if 2*sum(comb(rounds,j) for j in range(i+1)) / 2**rounds <= .05)
def paired(case, delay, mode, baseline="external"):
    times = values(case,delay,mode,"firstMs")
    base = values(case,delay,baseline,"firstMs")
    ratios = sorted(t / b for t,b in zip(times,base))
    return median(ratios), ratios[rank], ratios[-rank-1]

labels = {"release":"Jco 1.13.0", "bundled":"Internal Oxc", "external":"External, ordinary import",
          "direct":"External, direct imports hinted", "transitive":"External, indirect imports hinted",
          "all":"External, all runtime modules hinted"}
print("| Asset delay | Build and hints | Import (ms) | First result (ms) | Last runtime fetch initiated (ms) | Paired first result / ordinary external |")
print("| --- | --- | ---: | ---: | ---: | ---: |")
for delay in (0,10):
    for mode in modes:
        last = "—" if mode in ("release","bundled") else f"{typical(delay,mode,'startMs'):.2f}"
        ratio = median(paired(c,delay,mode)[0] for c in cases)
        print(f"| {delay} ms | {labels[mode]} | {typical(delay,mode,'loadMs'):.2f} | {typical(delay,mode,'firstMs'):.2f} | {last} | {ratio:.3f}× |")
print("\n| Case | Delay | Direct hints / external | Indirect hints / external | All hints / external |")
print("| --- | ---: | ---: | ---: | ---: |")
for case in cases:
    for delay in (0,10):
        cells = ["%.3f× (%.3f–%.3f)" % paired(case,delay,m) for m in modes[3:]]
        print("|",case,"|",delay,"ms |"," | ".join(cells),"|")
if args.plot:
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(1,2,figsize=(9,4.1),sharey=True,sharex=True,layout="constrained")
    for ax, delay in zip(axes,(0,10)):
        for m, offset, marker, color in zip(modes[3:],(-.21,0,.21),("s","x","o"),("#626978","#AD4524","#00796B")):
            for i, c in enumerate(cases):
                mid,lo,hi = paired(c,delay,m)
                ax.errorbar(mid,i+offset,xerr=[[mid-lo],[hi-mid]],fmt=marker,color=color,capsize=2,label=m.capitalize() if i==0 else None)
        ax.axvline(1,color="#555",lw=1)
        ax.set_title("Loopback" if not delay else "10 ms server delay per asset")
        ax.set_xlabel("First-result time / ordinary external")
        ax.grid(axis="x",alpha=.2)
    names = {"c":"C","cpp":"C++","rust":"Rust", "dom-query":"DOM query", "table-update":"table update"}
    axes[0].set_yticks(range(len(cases)),[" ".join(names[v] for v in c.strip("/").split("/")) for c in cases])
    axes[0].invert_yaxis()
    fig.legend(*axes[0].get_legend_handles_labels(),loc="outside lower center",ncol=3)
    fig.savefig(args.plot,dpi=150)
