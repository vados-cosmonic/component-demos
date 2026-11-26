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
wasm_preload = data["study"] == "--wasm-preload"
assert wasm_preload or data["study"] == "--modulepreload"
assert data["matrixSha256"] == sha256(matrix_file.read_bytes()).hexdigest()
archived = "e6af90c34ae52af9bcb1cee2777ec6f41bb35a19fb0919bb37967e1535a79fe6"
source = "125e9124d552008277eedc82ed77f88aa5ae7e0fff0ab74ea7bf70387151a419" if sha256(args.input.read_bytes()).hexdigest() == archived else sha256((bench / "core-startup.mjs").read_bytes()).hexdigest()
assert data["runnerSha256"] == source
with gzip.open(matrix_file) as f:
    reference = json.load(f)
assert data["release"] == "1.13.0"
for path, meta in data["manifest"].items():
    assert (meta["sha256"], meta["bytes"]) == (reference["manifest"][path]["sha256"],reference["manifest"][path]["bytes"])
builds = ["release", "bundled", "external"]
modes = builds + ([b + "-preload" for b in builds] if wasm_preload else ["direct", "transitive", "all"])
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
    build = mode.removesuffix("-preload")
    if build not in builds:
        build = "external"
    entry = case + "/" + build + "/" + cases[case]["name"]
    hints = data["hintLists"][case]
    assert set(hints["direct"]).isdisjoint(hints["transitive"])
    assert set(hints["all"]) == set(hints["direct"]) | set(hints["transitive"])
    expected = {entry+".js", entry+".core.wasm"}
    if build == "external":
        expected.update(hints["all"])
    by_path = {q["path"]: q for q in row["requests"]}
    assert expected == set(by_path) and len(expected) == len(row["requests"])
    if wasm_preload:
        assert row["wasmResponses"] == 1
        assert by_path[entry+".core.wasm"]["initiator"] == ("link" if mode.endswith("-preload") else "fetch")
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
        if field == "wasmStartMs":
            result.append(next(q["startMs"] for q in row["requests"] if q["path"].endswith(".wasm")))
        elif field in ("startMs","endMs"):
            result.append(max(q[field] for q in row["requests"] if q["path"].startswith("/runtime/")))
        else:
            result.append(row[field])
    return result

def typical(delay, mode, field):
    return median(median(values(c,delay,mode,field)) for c in cases)

rank = max(i for i in range(rounds) if 2*sum(comb(rounds,j) for j in range(i+1)) / 2**rounds <= .05)
def paired(case, delay, mode):
    baseline = mode.removesuffix("-preload") if wasm_preload else "external"
    times = values(case,delay,mode,"firstMs")
    base = values(case,delay,baseline,"firstMs")
    ratios = sorted(t / b for t,b in zip(times,base))
    return median(ratios), ratios[rank], ratios[-rank-1]

labels = {"release":"Jco 1.13.0", "bundled":"Internal Oxc", "external":"External, ordinary import",
          "direct":"External, direct imports hinted", "transitive":"External, indirect imports hinted",
          "all":"External, all runtime modules hinted"}
if wasm_preload:
    labels["external"] = "External runtime"
    print("| Delay | Build | Wasm request start (ms), ordinary → hinted | First result (ms), ordinary → hinted | Paired first result |")
    print("| --- | --- | ---: | ---: | ---: |")
    for delay in (0,10):
        for build in builds:
            hinted = build + "-preload"
            def both(field):
                return f"{typical(delay,build,field):.2f} → {typical(delay,hinted,field):.2f}"
            ratio = median(paired(c,delay,hinted)[0] for c in cases)
            print(f"| {delay} ms | {labels[build]} | {both('wasmStartMs')} | {both('firstMs')} | {ratio:.3f}× |")
    print("\n| Case | Delay | Jco 1.13.0 hinted / ordinary | Internal Oxc hinted / ordinary | External hinted / ordinary |")
else:
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
            series = labels[m.removesuffix("-preload")] if wasm_preload else m.capitalize()
            for i, c in enumerate(cases):
                mid,lo,hi = paired(c,delay,m)
                ax.errorbar(mid,i+offset,xerr=[[mid-lo],[hi-mid]],fmt=marker,color=color,capsize=2,label=series if i==0 else None)
        ax.axvline(1,color="#555",lw=1)
        ax.set_title("Loopback" if not delay else "10 ms server delay per asset")
        ax.set_xlabel("First-result time / ordinary load" if wasm_preload else "First-result time / ordinary external")
        ax.grid(axis="x",alpha=.2)
    names = {"c":"C","cpp":"C++","rust":"Rust", "dom-query":"DOM query", "table-update":"table update"}
    axes[0].set_yticks(range(len(cases)),[" ".join(names[v] for v in c.strip("/").split("/")) for c in cases])
    axes[0].invert_yaxis()
    fig.legend(*axes[0].get_legend_handles_labels(),loc="outside lower center",ncol=3)
    fig.savefig(args.plot,dpi=150)
