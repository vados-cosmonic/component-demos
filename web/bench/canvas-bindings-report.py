"""Check canvas outputs, within-page order and matched Wasm before summarizing timings."""
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
parser.add_argument("input", nargs="?", type=Path, default=bench / "results/canvas-bindings.json.gz")
parser.add_argument("--plot", type=Path)
args = parser.parse_args()
with gzip.open(args.input) as f:
    run = json.load(f)
def digest(path):
    return sha256(path.read_bytes()).hexdigest()

matrix_file = bench / "results/review-matrix-minified-eaca992c8.json.gz"
assert run["matrixSha256"] == digest(matrix_file)
assert run["runnerSha256"] == digest(bench / "canvas-bindings.mjs")
with gzip.open(matrix_file) as f:
    manifest = json.load(f)["manifest"]
for path, expected in run["hashes"].items():
    if path.startswith("/bench/"):
        assert digest(bench.parent / path[1:]) == expected
    else:
        assert manifest[path]["sha256"] == expected
rounds = run["rounds"]
assert run["languages"] == ["c", "cpp", "rust"] and run["hosts"] == ["original", "observed", "replay"]
assert run["modes"] == ["direct", "release", "bundled", "external"]
rows = {}
for row in run["samples"]:
    l, h, r, p, m = key = tuple(row[k] for k in ("lang", "host", "round", "pass", "mode"))
    assert key not in rows and 0 <= r < rounds and p in range(1, 5)
    assert row["pixels"] == 2 * run["size"]**2 and min(row["readUs"], row["writeUs"]) > 0
    if h == "replay":
        assert row["fills"] == 0 and row["reads"] >= 1 and row["reads"] & (row["reads"] + 1) == 0
    else:
        assert row["fills"] == row["reads"] == 0
    if h == "observed":
        o = row["observed"]
        assert o["bytes"] == (run["size"] - 80)**2 * 4 and o["reps"] > 0 and o["reps"] & (o["reps"]-1) == 0
        assert 0 < o["hostUs"] <= o["totalUs"] and abs(o["totalUs"] - row["readUs"]) <= .11
        assert abs(o["totalUs"] - o["hostUs"] - o["remainderUs"]) < 1e-7
    else:
        assert "observed" not in row
    rows[key] = row
assert len(rows) == len(run["languages"]) * len(run["hosts"]) * rounds * 16
for l in run["languages"]:
    for h in run["hosts"]:
        for r in range(rounds):
            positions, predecessors = Counter(), Counter()
            for p in range(1,5):
                ordered = sorted((rows[l,h,r,p,m]["position"], m) for m in run["modes"])
                assert [i for i, _ in ordered] == list(range(4))
                positions.update(ordered)
                predecessors.update((a[1], b[1]) for a,b in zip(ordered, ordered[1:]))
            assert len(positions) == 16 and set(positions.values()) == {1}
            assert len(predecessors) == 12 and set(predecessors.values()) == {1}

rank = max(i for i in range(rounds) if 2*sum(comb(rounds,j) for j in range(i+1)) / 2**rounds <= .05)
def summary(lang, host, mode, field, relative=False):
    def value(r, p):
        row = rows[lang,host,r,p,mode]
        if field == "hostShare":
            return 100 * row["observed"]["hostUs"] / row["observed"]["totalUs"]
        if field == "remainderUs":
            return row["observed"][field]
        if relative:
            return row[field] / rows[lang,host,r,p,"release"][field]
        return row[field]
    vals = sorted(median(value(r,p) for p in range(1,5)) for r in range(rounds))
    return median(vals), vals[rank], vals[-rank-1]

langs = {"c":"C", "cpp":"C++", "rust":"Rust"}
builds = {"direct":"Direct shim", "release":"Jco 1.13.0", "bundled":"Internal Oxc", "external":"External runtime"}
print("| Guest | Build | Original read (µs) | Original / 1.13.0 | Inside host (%) | Outside host (µs) | Replay read (µs) | Replay / 1.13.0 |")
print("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |")
for l, lang in langs.items():
    for m, mode in builds.items():
        def paired(h):
            mid, lo, hi = summary(l,h,m,"readUs",True)
            return f"{mid:.2f}× ({lo:.2f}–{hi:.2f})"
        print(f"| {lang} | {mode} | {summary(l,'original',m,'readUs')[0]:.1f} | {paired('original')} | "
              f"{summary(l,'observed',m,'hostShare')[0]:.1f} | {summary(l,'observed',m,'remainderUs')[0]:.1f} | "
              f"{summary(l,'replay',m,'readUs')[0]:.1f} | {paired('replay')} |")

if args.plot:
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(1, 2, figsize=(9, 3.5), sharey=True, layout="constrained")
    for ax, (h, title) in zip(axes, [("original","Original canvas host"), ("replay","Repeated snapshot")]):
        for i, l in enumerate(langs):
            for m, label, offset, marker, color in [
                ("direct","Direct shim",-.19,"s","#626978"), ("bundled","Internal Oxc",0,"o","#00796B"),
                ("external","External runtime",.19,"x","#AD4524")]:
                mid, lo, hi = summary(l,h,m,"readUs",True)
                ax.errorbar(mid, i+offset, xerr=[[mid-lo],[hi-mid]], fmt=marker, color=color, capsize=2, label=label if i==0 else None)
        ax.axvline(1,color="#555",lw=1)
        ax.grid(axis="x",alpha=.2)
        ax.set_title(title)
        ax.set_xlabel("Time / Jco 1.13.0 time")
    axes[0].set_yticks(range(len(langs)), langs.values())
    axes[0].invert_yaxis()
    fig.legend(*axes[0].get_legend_handles_labels(), loc="outside lower center", ncol=3)
    fig.savefig(args.plot, dpi=150)
