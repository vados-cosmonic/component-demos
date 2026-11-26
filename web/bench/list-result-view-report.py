"""Validate the paired controls and summarize list-return and canvas readback times."""
import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import json
from math import comb
from pathlib import Path
from statistics import median

bench = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("input", type=Path)
parser.add_argument("--plot", type=Path)
args = parser.parse_args()
with gzip.open(args.input) as src:
    result = json.load(src)
matrix_bytes = (bench / "results/review-matrix-init-ae16355e9.json.gz").read_bytes()
matrix = json.loads(gzip.decompress(matrix_bytes))
for key, data in [("matrix", matrix_bytes), ("fixture", (bench / "byte-transfer.wat").read_bytes()),
                  ("runner", (bench / "list-result-view.mjs").read_bytes())]:
    assert hashlib.sha256(data).hexdigest() == result[key], key

modes = ["bundled", "external", "bundled-trial", "external-trial"]
assert result["modes"] == modes
assert len(result["sites"]) == 14 and set(result["sites"].values()) == {1}
assets = result["manifest"]
for path, asset in assets.items():
    if "-trial/" in path:
        control = assets[path.replace("-trial/", "/")]
        assert (asset["sha256"] == control["sha256"]) == path.endswith(".wasm"), path
    elif path in matrix["manifest"]:
        assert asset["sha256"] == matrix["manifest"][path]["sha256"], path
for demo in ("canvas-pixels", "string-marshalling"):
    core = "/" + demo.replace("-", "_") + ".core.wasm"
    for guest in ("c", "cpp", "rust"):
        root = f"/{guest}/{demo}/"
        assert len({assets[root + mode + core]["sha256"] for mode in modes}) == 1
for name in ["copy.core.wasm", "copy.core2.wasm"]:
    assert len({assets[f"/fixture/{mode}/{name}"]["sha256"] for mode in modes}) == 1

rounds = result["rounds"]
times = {}
order = defaultdict(dict)
for row in result["samples"]:
    key = (row["guest"], row["length"], row["round"], row["pass"])
    mode, pos = row["mode"], row["position"]
    assert pos not in order[key] and (*key, mode) not in times
    times[(*key, mode)] = row["nsPerCall"]
    order[key][pos] = mode
cases = [("copy", n) for n in (16, 256, 4096, 123904)]
for lang in ("c", "cpp", "rust"):
    cases.append((lang+"/canvas-pixels", 123904))
    cases.extend((lang+"/string-marshalling", n) for n in (8,128,1024,16384,262144))
assert len(times) == rounds * len(modes) * (7 * 4 + 15)
rank = max(i for i in range(rounds // 2) if 2 * sum(comb(rounds,j) for j in range(i+1)) / 2**rounds <= .05)
print("| Workload | Internal PR → trial (µs) | Internal trial / PR | External PR → trial (µs) | External trial / PR |")
print("| --- | ---: | ---: | ---: | ---: |")
plotted = defaultdict(list)
for guest, length in cases:
    strings = guest.endswith("/string-marshalling")
    passes = [1] if strings else range(4,8)
    ratios = defaultdict(list)
    positions, predecessors = Counter(), Counter()
    for r in range(rounds):
        for p in passes:
            key = guest, length, r, p
            sequence = [order[key][i] for i in range(4)]
            assert set(sequence) == set(modes)
            positions.update(enumerate(sequence))
            predecessors.update(zip(sequence, sequence[1:]))
        if not strings or r % 4 == 3:
            assert len(positions) == 16 and set(positions.values()) == {1}
            assert len(predecessors) == 12 and set(predecessors.values()) == {1}
            positions.clear()
            predecessors.clear()
        for mode in modes[:2]:
            ratios[mode].append(median(times[guest,length,r,p,mode+"-trial"] / times[guest,length,r,p,mode] for p in passes))
    label = f"Return {length:,} bytes"
    if guest != "copy":
        lang = {"c":"C", "cpp":"C++", "rust":"Rust"}[guest.split("/")[0]]
        label = f"{lang} get {length:,} B string" if strings else f"{lang} canvas readback"
    cells = []
    for mode in modes[:2]:
        us = [median(median(times[guest,length,r,p,label] for p in passes) for r in range(rounds)) / 1000
              for label in (mode, mode+"-trial")]
        cells.append(f"{us[0]:.3f} → {us[1]:.3f}")
        xs = sorted(ratios[mode])
        plotted[strings, mode].append((label, median(xs), xs[rank], xs[-rank-1]))
        cells.append(f"{median(xs):.3f}× ({xs[rank]:.3f}–{xs[-rank-1]:.3f})")
    print("|", label, "|", " | ".join(cells), "|")

if args.plot:
    import matplotlib.pyplot as plt
    from matplotlib.ticker import FuncFormatter, MultipleLocator

    fig, axes = plt.subplots(1, 2, figsize=(12, 6), layout="constrained")
    for ax, strings, title in zip(axes, (False, True), ("Byte-list returns and canvas readback", "String returns in the demos")):
        for mode, offset, color, marker, name in [
            ("bundled", -.14, "#12647a", "o", "Internal Oxc"),
            ("external", .14, "#a54e20", "s", "External runtime"),
        ]:
            series = plotted[strings,mode]
            centers = [mid for _,mid,_,_ in series]
            errors = [[mid-lo for _,mid,lo,_ in series], [hi-mid for _,mid,_,hi in series]]
            ax.errorbar(centers, [i+offset for i in range(len(series))], xerr=errors,
                        fmt=marker, color=color, markersize=4, capsize=2, label=name)
        ax.set_yticks(range(len(series)), [label.replace(" string", "") for label, *_ in series])
        ax.invert_yaxis()
        ax.axvline(1, linestyle="--", color="#555", linewidth=1)
        ax.set_title(title, fontsize=12)
        ax.set_xlabel("Trial time / PR time")
        ax.xaxis.set_major_formatter(FuncFormatter(lambda value, _: f"{value:.1f}×"))
        ax.xaxis.set_major_locator(MultipleLocator(.2 if strings else .1))
        ax.grid(axis="x", color="#ddd", linewidth=.6)
        for spine in ("top", "right"):
            ax.spines[spine].set_visible(False)
    axes[0].legend(loc="upper left", bbox_to_anchor=(0, -.1), ncols=2, frameon=False)
    fig.savefig(args.plot, dpi=150)
