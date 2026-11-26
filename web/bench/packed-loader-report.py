"""Compare six cold component loads using one multi-entry application bundle."""
from sign_interval import median_sign_index
from collections import Counter
from hashlib import sha256
import gzip
import json
from pathlib import Path
from statistics import median
import argparse

parser = argparse.ArgumentParser(description=__doc__)
for argument in ("archive", "reference", "runner"):
    parser.add_argument(argument, type=Path)
parser.add_argument("--plot", type=Path)
args = parser.parse_args()
archive, reference, runner = args.archive, args.reference, args.runner
run, matrix = [json.loads(gzip.decompress(p.read_bytes())) for p in (archive, reference)]
assert run["study"] == "--packed-loader" and run["rounds"] == 12
assert run["matrixSha256"] == sha256(reference.read_bytes()).hexdigest()
assert run["runnerSha256"] == sha256(runner.read_bytes()).hexdigest()
assert run["appBundlerSha256"] == sha256(Path(__file__).with_name("app-bundle.mjs").read_bytes()).hexdigest()
assert run["chromium"] == matrix["chromium"]
cases = run["cases"]
assert set(cases) == {f"{lang}/{demo}" for demo in ("dom-query", "table-update") for lang in ("c", "cpp", "rust")}
modes = ["release", "release-parallel", "bundled-parallel", "external-parallel", "packed-parallel", "preloaded-parallel"]
assert run["builds"] == modes
assert run["profiles"] == ["loopback", "limited"] and run["protocols"] == ["h2"]
assert run["emulation"] == dict(latency=40, download=1250000, upload=1250000)
assert run["contentEncoding"] == "br" and run["brotliQuality"] == 11
assert run["inputs"] == {demo: list(matrix["workloads"][demo].values()) for demo in ["dom-query", "table-update"]}
files, layouts = run["files"], run["expected"]
chunks = set()
for case in cases:
    layout = layouts[case]
    packed = layout["packed-parallel"]
    assert {**packed, "hint": layout["preloaded-parallel"]["hint"]} == layout["preloaded-parallel"]
    shared = layout["preloaded-parallel"]["hint"]
    assert shared in packed["requests"] and shared.startswith("/app-chunks/")
    assert [p for p in packed["requests"] if p.endswith(".js")] == sorted([packed["entry"], shared])
    chunks.add(shared)
    for f in layout["external-parallel"]["requests"]:
        if f.endswith(".wasm"):
            path = f.replace("/external-instantiate/", "/external-instantiate-app/")
            assert files[path] == files[f] and path in packed["requests"]
    primary, = [p for p in layout["release"]["requests"] if p.endswith(".wasm")]
    for mode in modes[1:]:
        assert files[primary]["sha256"] in {files[p]["sha256"] for p in layout[mode]["requests"] if p.endswith(".wasm")}
assert len(chunks) == 1
samples, orders = {}, {}
for s in run["samples"]:
    case, mode, profile, rnd = (s[k] for k in ("workload", "mode", "profile", "round"))
    key = case, mode, profile, rnd
    assert key not in samples
    samples[key] = s
    paths = layouts[case][mode]["requests"]
    requests = {r["path"]: r for r in s["requests"]}
    assert sorted(requests) == paths == sorted(s["served"])
    assert len(paths) == len(s["requests"])
    for path, r in requests.items():
        assert r["protocol"] == "h2" and r["bytes"] == files[path]["brotli"] and r["decoded"] == files[path]["bytes"]
        if mode == "release" or path.startswith("/runtime/"):
            assert files[path]["sha256"] == matrix["manifest"][path]["sha256"]
    if mode == "preloaded-parallel":
        assert requests[layouts[case][mode]["hint"]]["start"] < requests[layouts[case][mode]["entry"]]["end"]
    orders.setdefault((case, rnd), {})[s["position"]] = (profile, mode)
rounds = range(run["rounds"])
assert len(samples) == 864
for case in cases:
    positions, adjacencies = Counter(), Counter()
    for rnd in rounds:
        order = [orders[case, rnd][i] for i in range(12)]
        positions.update(enumerate(order))
        adjacencies.update(zip(order, order[1:]))
    assert len(positions) == 144 and len(adjacencies) == 132
    assert set(positions.values()) == set(adjacencies.values()) == {1}

def interval(values):
    values = sorted(values)
    n = len(values)
    rank = median_sign_index(n)
    return f"{median(values):.3f} ({values[rank]:.3f}–{values[-1-rank]:.3f})"

for profile in run["profiles"]:
    for mode in modes:
        first = median(median(samples[c, mode, profile, r]["firstMs"] for r in rounds) for c in cases)
        print(profile, mode, "median first result (ms)", round(first, 2))
    for mode, control in [("packed-parallel", "external-parallel"), ("preloaded-parallel", "packed-parallel"),
                          ("preloaded-parallel", "external-parallel"), ("preloaded-parallel", "bundled-parallel"),
                          ("preloaded-parallel", "release"), ("preloaded-parallel", "release-parallel")]:
        ratios = [median(samples[c, mode, profile, r]["firstMs"] / samples[c, control, profile, r]["firstMs"]
                         for c in cases) for r in rounds]
        print(profile, mode, "/", control, interval(ratios))
    for mode in ("bundled-parallel", "preloaded-parallel"):
        phases = {k: [] for k in ("last response", "last response to ready", "import", "guest", "total")}
        for r in rounds:
            gaps = []
            for c in cases:
                row = samples[c, mode, profile, r]
                release = samples[c, "release-parallel", profile, r]
                ready = row["importMs"] - release["importMs"]
                total = row["firstMs"] - release["firstMs"]
                last_response = max(req["end"] for req in row["requests"]) - max(req["end"] for req in release["requests"])
                gaps.append((last_response, ready - last_response, ready, total - ready, total))
            for values, by_case in zip(phases.values(), zip(*gaps)):
                values.append(median(by_case))
        print(profile, mode, "minus concurrent 1.13.0 (ms)", {k: interval(v) for k, v in phases.items()})
for mode in modes:
    js = [{p for p in layouts[c][mode]["requests"] if p.endswith(".js")} for c in cases]
    print(mode, "JS requests per component", sorted({len(paths) for paths in js}),
          "median Brotli JS bytes", median(sum(files[p]["brotli"] for p in paths) for paths in js),
          "unique Brotli JS bytes across six", sum(files[p]["brotli"] for p in set.union(*js)))

if args.plot:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(8.4, 3.6), layout="constrained")
    labels = ["1.13.0, ordinary import", "1.13.0, concurrent loader", "Internal Oxc, concurrent",
              "External package, concurrent", "External bundle, concurrent", "External bundle + preload, concurrent"]
    for profile, label, offset, color, marker in [("loopback", "Loopback", -.10, "#126F79", "o"),
                                                  ("limited", "40 ms, 10 Mbit/s", .10, "#A63E27", "s")]:
        ms = [median(median(samples[c, m, profile, r]["firstMs"] for r in rounds) for c in cases) for m in modes]
        ax.scatter(ms, [i + offset for i in range(len(modes))], label=label, color=color, marker=marker)
    ax.set_yticks(range(len(modes)), labels)
    ax.invert_yaxis()
    ax.set_xlim(left=0)
    ax.grid(axis="x", alpha=.25)
    ax.set_xlabel("Time to first result (ms), median across six workloads")
    ax.legend(loc="upper center", bbox_to_anchor=(.5, 1.18), ncol=2, frameon=False)
    fig.savefig(args.plot, dpi=165)
