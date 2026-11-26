"""Validate exact network graphs and compare layouts at the same TLS protocol and workload."""

import argparse
from collections import Counter
import gzip
from hashlib import sha256
import json
from math import comb
from pathlib import Path
from statistics import median

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("samples", type=Path)
parser.add_argument("matrix", type=Path)
parser.add_argument("--plot", type=Path)
args = parser.parse_args()
with gzip.open(args.samples) as stream:
    run = json.load(stream)
with gzip.open(args.matrix) as stream:
    matrix = json.load(stream)
assert sha256(args.matrix.read_bytes()).hexdigest() == run["matrixSha256"]
assert sha256(Path(__file__).with_name("runtime-chunks.mjs").read_bytes()).hexdigest() == run["runnerSha256"]
assert matrix["candidate"] == run["revision"]
assert sha256(Path(__file__).with_name("app-bundle.mjs").read_bytes()).hexdigest() == run["appBundlerSha256"]
files, cases, probe = run["files"], run["cases"], run["probe"]
protocols, builds, rounds = run["protocols"], run["builds"], run["rounds"]
assert len(cases) == 6 and rounds == 20 and protocols == ["http/1.1", "h2"]
assert builds == ["release", "bundled", "external", "grouped", "application"]
for path, asset in files.items():
    if path.startswith(("/grouped/", "/app-chunks/")) or ("/external-app/" in path and path.endswith(".js")):
        continue
    path = path.replace("/external-app/", "/external/")
    assert all(asset[k] == matrix["manifest"][path][k] for k in ("sha256", "bytes")), path

cells = {}
positions, predecessors = Counter(), Counter()
for work in [*cases, probe]:
    modes = ["external", "grouped"] if work == probe else builds
    for r in range(rounds):
        block = sorted((s for s in run["samples"] if s["workload"] == work and s["round"] == r),
                       key=lambda s: s["position"])
        order = [(s["protocol"], s["mode"]) for s in block]
        assert sorted(order) == sorted((p, m) for p in protocols for m in modes)
        assert [s["position"] for s in block] == list(range(len(order)))
        positions.update((work, i, t) for i, t in enumerate(order))
        predecessors.update((work, a, b) for a, b in zip(order, order[1:]))
        for s in block:
            protocol, mode = s["protocol"], s["mode"]
            requests = s["requests"]
            assert s["firstMs"] >= s["importMs"] > 0
            assert sorted(q["path"] for q in requests) == run["expected"][work][mode]["requests"]
            for q in requests:
                assert q["protocol"] == protocol and q["transferred"] > 0
                assert q["bytes"] == files[q["path"]]["bytes"]
                assert -.02 <= q["start"] <= q["end"] <= s["firstMs"] + .02
            cells[work, protocol, mode, r] = s
    treatments = len(modes) * len(protocols)
    for counter, count in [(positions, treatments**2), (predecessors, treatments * (treatments - 1))]:
        observed = [n for k, n in counter.items() if k[0] == work]
        assert len(observed) == count and set(observed) == {rounds // treatments}
assert len(cells) == len(run["samples"]) == 1280

rank = max(i for i in range(rounds)
           if 2 * sum(comb(rounds, j) for j in range(i + 1)) / 2**rounds <= .05)


def times(work, protocol, mode):
    return [cells[work, protocol, mode, r]["firstMs"] for r in range(rounds)]


def paired(work, protocol, a, b):
    values = sorted(x/y for x, y in zip(times(work, protocol, a), times(work, protocol, b), strict=True))
    return median(values), values[rank], values[-rank - 1]


def ms(workloads, protocol, mode):
    return median(median(times(w, protocol, mode)) for w in workloads)


def footprint(paths):
    return len(paths), sum(files[p]["bytes"] for p in paths), sum(files[p]["gzip"] for p in paths)


print("Static module footprints. Columns give modules, JS bytes and sum of gzipped bytes.")
for mode, prefix in [("external", "/runtime/"), ("grouped", "/grouped/")]:
    demos = set()
    for w in cases:
        paths = [p for p in run["expected"][w][mode]["requests"] if p.startswith(prefix)]
        demos.add(footprint(paths))
    assert len(demos) == 1
    print(mode, "demo runtime", next(iter(demos)))
    print(mode, "conversion only", footprint(run["footprints"][mode]["intrinsics/conversion"]))

for protocol in protocols:
    print(protocol, "median first result (ms)")
    for mode in builds:
        print(mode, f"{ms(cases, protocol, mode):.2f}")
    for work in [*cases, probe]:
        mid, lo, hi = paired(work, protocol, "grouped", "external")
        print("grouped", work, f"{ms([work], protocol, 'external'):.2f}", f"{ms([work], protocol, 'grouped'):.2f}",
              f"{mid:.3f}× ({lo:.3f}–{hi:.3f})")

    for work in cases:
        mid, lo, hi = paired(work, protocol, "application", "external")
        print("application", work, f"{ms([work],protocol,'application'):.2f}", f"{mid:.3f}× ({lo:.3f}–{hi:.3f})")

if args.plot:
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(1, 2, sharey=True, figsize=(8.4, 3.6), layout="constrained")
    labels = [w.replace("cpp/", "C++/").replace("rust/", "Rust/").replace("c/", "C/").replace("/", " · ")
              for w in cases] + ["Conversion only"]
    for ax, protocol in zip(axes, protocols, strict=True):
        for i, w in enumerate([*cases, probe]):
            mid, lo, hi = paired(w, protocol, "grouped", "external")
            ax.errorbar(mid, i - .12, xerr=[[mid - lo], [hi - mid]], fmt="o", color="#00796b", capsize=3,
                        label="Grouped package" if i == 0 else None)
            if w != probe:
                mid, lo, hi = paired(w, protocol, "application", "external")
                ax.errorbar(mid, i + .12, xerr=[[mid - lo], [hi - mid]], fmt="s", color="#ad4524", capsize=3,
                            label="Application bundle" if i == 0 else None)
        ax.set_title({"h2": "HTTP/2", "http/1.1": "HTTP/1.1"}[protocol])
        ax.set_xlabel("First result time / shipped layout")
        ax.axvline(1, color="#555", ls="--", lw=1)
        ax.grid(axis="x", alpha=.2)
    axes[0].set_yticks(range(len(labels)), labels)
    axes[0].invert_yaxis()
    fig.legend(*axes[0].get_legend_handles_labels(), loc="outside lower center", ncol=2)
    fig.savefig(args.plot, dpi=160)
