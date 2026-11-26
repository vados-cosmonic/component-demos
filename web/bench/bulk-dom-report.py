"""Check matched host work and compare each renderer with the same guest on the direct host."""
from collections import Counter, defaultdict
import argparse
import gzip
from hashlib import sha256
import json
from math import comb
from pathlib import Path
from statistics import median

bench = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument("input", type=Path, nargs="?", default=bench / "results/bulk-dom.json.gz")
parser.add_argument("--plot", type=Path)
args = parser.parse_args()
with gzip.open(args.input) as f:
    run = json.load(f)
assert sha256((bench / "bulk-dom.mjs").read_bytes()).hexdigest() == run["runnerSha256"]
for file in ("host/web-host.js", "host/common.js", "examples/dom-query/main.js", "bench/dom-core-shim.mjs"):
    assert sha256((bench.parent / file).read_bytes()).hexdigest() == run["manifest"]["/" + file]
for lang in run["languages"]:
    base = f"/{lang}/dom-query/"
    core = "dom_query.core.wasm"
    release = run["manifest"][base + "release/" + core]
    assert release == sha256((bench.parent / lang / "dom-query/jco-baseline" / core).read_bytes()).hexdigest()
    assert all(run["manifest"][base + mode + "/" + core] == release for mode in ("bundled", "external"))
rounds, modes = run["rounds"], run["modes"]
expected = {(lang, size, r) for lang in run["languages"] for size in run["sizes"] for r in range(rounds)}
assert len(run["checks"]) == len(expected)
for check in run["checks"]:
    expected.remove((check["lang"], check["size"], check["round"]))
    iterations, remainder = divmod(run["total"], check["size"])
    assert remainder == 0
    assert check["hostCounts"] == {mode: {"calls": iterations, "elements": run["total"]} for mode in modes}
    # One instrumented call, four warmups and four measurement calls per guest.
    assert check["direct"] == {"liveHandles": 0, "listCount": 9 * iterations, "listElements": 9 * run["total"]}
assert not expected
cells = defaultdict(dict)
positions = Counter()
for row in run["samples"]:
    lang, size, r, p, mode = (row[k] for k in ("lang", "size", "round", "pass", "mode"))
    key = lang, size, r, p
    assert lang in run["languages"] and size in run["sizes"] and 0 <= r < rounds and p in range(4, 8)
    assert mode in modes and row["position"] in range(len(modes))
    assert mode not in cells[key] and row["bulkMs"] > 0
    cells[key][mode] = row["bulkMs"]
    positions[lang, size, r, row["position"], mode] += 1
assert len(cells) == rounds * len(run["sizes"]) * len(run["languages"]) * 4
assert all(len(c) == len(modes) for c in cells.values())
assert len(positions) == len(cells) * len(modes) and set(positions.values()) == {1}
rank = max(k for k in range(rounds) if 2 * sum(comb(rounds, j) for j in range(k+1)) / 2**rounds <= .05)

def ratio(lang, size, a, b):
    values = sorted(median(cells[lang, size, r, p][a] / cells[lang, size, r, p][b] for p in range(4, 8))
                    for r in range(rounds))
    return median(values), values[rank], values[-rank-1]

print("| Guest | Handles per query | Direct (ms) | 1.13.0 / direct | Bundled / direct | External / direct | Bundled / 1.13.0 | External / 1.13.0 |")
print("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
for lang in run["languages"]:
    for size in run["sizes"]:
        ms = median(median(cells[lang, size, r, p]["direct"] for p in range(4, 8)) for r in range(rounds))
        ratios = [ratio(lang, size, a, b) for a,b in (("release","direct"), ("bundled","direct"),
                  ("external","direct"), ("bundled","release"), ("external","release"))]
        cells_text = [f"{mid:.2f}× ({lo:.2f}–{hi:.2f})" for mid, lo, hi in ratios]
        print("|", " | ".join([{"c":"C","cpp":"C++","rust":"Rust"}[lang], str(size), f"{ms:.2f}", *cells_text]), "|")

if args.plot:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(8, 4.8), layout="constrained")
    cases = [(lang, size) for lang in run["languages"] for size in run["sizes"]]
    for mode, label, offset, color, marker in [
        ("release", "Jco 1.13.0", -.21, "#5A6173", "s"),
        ("bundled", "Internal Oxc", 0, "#00796B", "o"),
        ("external", "External runtime", .21, "#AD4524", "x"),
    ]:
        for i, (lang, size) in enumerate(cases):
            mid, lo, hi = ratio(lang, size, mode, "direct")
            ax.errorbar(mid, i+offset, xerr=[[mid-lo], [hi-mid]], fmt=marker, color=color, ms=4,
                        capsize=2, lw=1, label=label if i == 0 else None)
    ax.axvline(1, color="#555", lw=1)
    labels = {"c": "C", "cpp": "C++", "rust": "Rust"}
    ax.set_yticks(range(len(cases)), [f"{labels[lang]} · {size:,}" for lang, size in cases])
    ax.invert_yaxis()
    ax.set_ylabel("Guest and handles per query")
    ax.set_xlabel("Bulk query time / direct shim time")
    ax.grid(axis="x", alpha=.2)
    fig.legend(*ax.get_legend_handles_labels(), loc="outside lower center", ncol=3)
    fig.savefig(args.plot, dpi=160)
