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
parser.add_argument("--previous-matrix", type=Path, help="check regenerated automatic chunks against the earlier shipped package")
args = parser.parse_args()
with gzip.open(args.samples) as stream:
    run = json.load(stream)
with gzip.open(args.matrix) as stream:
    matrix = json.load(stream)
assert sha256(args.matrix.read_bytes()).hexdigest() == run["matrixSha256"]
app_preload = run.get("study") == "--shaped-preload"
automatic = run.get("study") == "--automatic-control"
core_hints = run.get("study") == "--core-hints"
shaped = core_hints or app_preload or automatic or run.get("study") == "--shaped"
runner_hash = sha256(Path(__file__).with_name("runtime-chunks.mjs").read_bytes()).hexdigest()
# The uncompressed transport trial used the original runner at 2cf7d38.
archived = {"976c95bd7fdf03cb25f46deb6ef2b87a4ca825cd8fd3b0cd0d6a5e661ddbb8df": "e17ab34cfd9e83216d789a96ee38e599a208c6360a5e4727d7478b6f0b907555"}
# The Brotli control ran before the preload treatment was added.
archived["819808b8fabdb74bd34aa85c138eaeaa03c8ce03bfadbf79d8dc63baea8e844d"] = "1d7f89b9f849e407a1d457456c80d03661bd926c82cf8de57c9273f01d54bad2"
# The preload run predates the compact helper grouping.
archived["6ca821aebda496bd78959086b2f9468d980a301ec695662192c5f65649479716"] = "2620a5793ba7ce816265fb34207f09affae47b0a042928fba2cbb1ba068f97b7"
# The compact helper trial used conversion as its standalone caller.
archived["f8bc0a73a0eef861abe07a01500d60f0d564bcdb6e92a6101cd8910e403d39bf"] = "2128c49f615f4df96366ad6e7a24ecd0f174704e47eb56b24b0bc08d34d2bd6d"
archived["d3f417ae8ca4615e56e972f09507c3a090df2400d55db5c333622d3cdd0a26d5"] = "44694858aab947f9bfef462f2f2667e7afef50e14a9ed6e9b9d5abca5a446e9e"
# The compact helper comparison predates the guest-core hint treatments.
archived["be8cb7251b40ff901d17df1058d09ab93c06511ef2dfeacff62fc322c13f1407"] = "249d37d612e90167a8725215c27603df59748cf1adae48b2c7ab182669824bba"
assert run["runnerSha256"] == archived.get(sha256(args.samples.read_bytes()).hexdigest(), runner_hash)
if not shaped:
    assert matrix["candidate"] == run["revision"]
assert sha256(Path(__file__).with_name("app-bundle.mjs").read_bytes()).hexdigest() == run["appBundlerSha256"]
files, cases, probe = run["files"], run["cases"], run["probe"]
protocols, builds, rounds = run["protocols"], run["builds"], run["rounds"]
assert len(cases) == 6
if shaped:
    assert rounds == (20 if core_hints else 16) and protocols == ["h2"]
    assert run["profiles"] == (["limited"] if app_preload else ["loopback", "limited"])
    assert run["emulation"] == {"latency": 40, "download": 1250000, "upload": 1250000}
    assert run["contentEncoding"] == "br" and run["brotliQuality"] == 11
    expected_inputs = ({name: list(matrix["workloads"][name].values()) for name in ("dom-query", "table-update")}
                       if automatic or core_hints else {"dom-query": [8, 2], "table-update": [8]})
    assert run["inputs"] == expected_inputs
    assert set(cases) == {f"{lang}/{demo}" for lang in ["c", "cpp", "rust"] for demo in run["inputs"]}
    if app_preload:
        for w in cases:
            ordinary, hinted = (run["expected"][w][m] for m in ["application", "application-preload"])
            assert ordinary["entry"] == hinted["entry"] and ordinary["requests"] == hinted["requests"]
            assert hinted["hint"] in ordinary["requests"] and hinted["hint"] != ordinary["entry"]
            assert hinted["hint"].endswith(".js")
    if core_hints:
        assert matrix["candidate"] == run["revision"]
        assert builds == ["release", "release-core", "bundled", "bundled-core", "external", "external-core",
                          "application", "application-core", "application-preload", "application-both"]
        for w in cases:
            layouts = run["expected"][w]
            for base in ["release", "bundled", "external", "application"]:
                core, = [p for p in layouts[base]["requests"] if p.endswith(".wasm")]
                assert layouts[base + "-core"] == {**layouts[base], "coreHint": core}
            chunk = layouts["application-preload"]["hint"]
            assert chunk.endswith(".js") and chunk != layouts["application"]["entry"] and chunk in layouts["application"]["requests"]
            assert layouts["application-preload"] == {**layouts["application"], "hint": chunk}
            assert layouts["application-both"] == {**layouts["application-core"], "hint": chunk}
    else:
        assert builds == (["release", "bundled", "application", "application-preload"] if app_preload
                      else ["release", "bundled", "external", "automatic" if automatic else "application"])
else:
    assert rounds == 20 and protocols == ["http/1.1", "h2"]
    assert builds == ["release", "bundled", "external", "grouped", "application"]
conditions = run["profiles"] if shaped else protocols
workloads = cases if shaped else [*cases, probe]
for path, asset in files.items():
    if path.startswith(("/grouped/", "/app-chunks/")) or ("/external-app/" in path and path.endswith(".js")):
        continue
    path = path.replace("/external-app/", "/external/")
    assert all(asset[k] == matrix["manifest"][path][k] for k in ("sha256", "bytes")), path

if args.previous_matrix:
    assert automatic, "--previous-matrix is for the automatic-splitting control"
    with gzip.open(args.previous_matrix) as stream:
        previous = json.load(stream)
    old_package = {p.removeprefix("/runtime/"): v["sha256"] for p, v in previous["manifest"].items()
                   if p.startswith("/runtime/")}
    control = {p.removeprefix("/grouped/"): v["sha256"] for p, v in files.items() if p.startswith("/grouped/")}
    assert control == old_package, "the control must reproduce every previously shipped runtime module"

cells = {}
positions, predecessors = Counter(), Counter()
for work in workloads:
    modes = ["external", "grouped"] if work == probe else builds
    for r in range(rounds):
        block = sorted((s for s in run["samples"] if s["workload"] == work and s["round"] == r),
                       key=lambda s: s["position"])
        order = [(s.get("profile", s["protocol"]), s["mode"]) for s in block]
        assert sorted(order) == sorted((p, m) for p in conditions for m in modes)
        assert [s["position"] for s in block] == list(range(len(order)))
        positions.update((work, i, t) for i, t in enumerate(order))
        predecessors.update((work, a, b) for a, b in zip(order, order[1:]))
        for s in block:
            protocol, mode = s["protocol"], s["mode"]
            requests = s["requests"]
            assert s["firstMs"] >= s["importMs"] > 0
            assert sorted(q["path"] for q in requests) == run["expected"][work][mode]["requests"]
            layout = run["expected"][work][mode]
            if core_hints:
                assert sorted(s["served"]) == layout["requests"]
                entry_end = next(q["end"] for q in requests if q["path"] == layout["entry"])
                for name in ["hint", "coreHint"]:
                    if name in layout:
                        assert next(q["start"] for q in requests if q["path"] == layout[name]) < entry_end
            for q in requests:
                assert q["protocol"] == protocol and q["transferred"] > 0
                assert q["bytes"] == files[q["path"]]["brotli" if shaped else "bytes"]
                if shaped:
                    assert q["decoded"] == files[q["path"]]["bytes"] and protocol == "h2"
                if mode == "application-preload" and q["path"] == run["expected"][work][mode]["hint"]:
                    entry = run["expected"][work][mode]["entry"]
                    assert q["start"] < next(r["end"] for r in requests if r["path"] == entry)
                assert -.02 <= q["start"] <= q["end"] <= s["firstMs"] + .02
            cells[work, s.get("profile", protocol), mode, r] = s
    treatments = len(modes) * len(conditions)
    for counter, count in [(positions, treatments**2), (predecessors, treatments * (treatments - 1))]:
        observed = [n for k, n in counter.items() if k[0] == work]
        assert len(observed) == count and set(observed) == {rounds // treatments}
assert len(cells) == len(run["samples"]) == (len(workloads) * rounds * len(builds) * len(conditions) if shaped else 1280)

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


if core_hints:
    comparisons = [(name + "-core", name) for name in ["release", "bundled", "external", "application"]]
    comparisons += [("application-preload", "application"), ("application-both", "application"),
                    ("application-both", "application-preload"), ("application-both", "application-core"),
                    ("bundled-core", "release-core"), ("external-core", "release-core"), ("application-both", "release-core")]
    for profile in conditions:
        for mode in builds:
            def wasm_start(work):
                return median(next(q["start"] for q in cells[work, profile, mode, r]["requests"]
                                   if q["path"].endswith(".wasm")) for r in range(rounds))
            print(profile, mode, "first and wasm start (ms)", round(ms(cases, profile, mode), 2),
                  round(median(wasm_start(w) for w in cases), 2))
        for a, b in comparisons:
            ratios = [paired(w, profile, a, b) for w in cases]
            print(profile, a, "/", b, round(median(x[0] for x in ratios), 3),
                  "intervals below / above parity", sum(x[2] < 1 for x in ratios), sum(x[1] > 1 for x in ratios))
    if args.plot:
        import matplotlib.pyplot as plt
        fig, axes = plt.subplots(1, 2, figsize=(8.8, 4.1), sharey=True, layout="constrained")
        labels = ["Jco 1.13.0", "Internal Oxc", "External package", "Application bundle"]
        for ax, profile in zip(axes, conditions, strict=True):
            for i, mode in enumerate(["release", "bundled", "external", "application"]):
                for selected, label, marker, color in [(mode, "Ordinary", "o", "#324153"),
                                                       (mode + "-core", "Wasm preload", "s", "#258578")]:
                    ax.scatter(ms(cases, profile, selected), i, label=label if i == 0 else None,
                               marker=marker, color=color, s=42)
            for selected, label, marker, color in [("application-preload", "JS preload", "^", "#b57435"),
                                                  ("application-both", "Both preloads", "D", "#703c84")]:
                ax.scatter(ms(cases, profile, selected), 3, label=label, marker=marker, color=color)
            ax.set_yticks(range(4), labels)
            ax.set_title("Loopback" if profile == "loopback" else "40 ms latency · 10 Mbit/s")
            ax.set_xlabel("Median time to first guest result (ms)")
            ax.set_xlim(left=0)
            ax.grid(axis="x", alpha=.2)
        axes[0].invert_yaxis()
        fig.legend(*axes[0].get_legend_handles_labels(), loc="outside lower center", ncols=4)
        fig.savefig(args.plot, dpi=160)
    raise SystemExit(0)

if shaped:
    for mode in builds:
        paths = [run["expected"][w][mode]["requests"] for w in cases]
        js_kib = median(sum(files[p]["brotli"] for p in group if p.endswith(".js")) for group in paths)/1024
        all_kib = median(sum(files[p]["brotli"] for p in group) for group in paths)/1024
        print(mode, "Brotli KiB (JS / JS + Wasm)", round(js_kib, 2), round(all_kib, 2),
              "requests", sorted(set(map(len, paths))))
    for profile in conditions:
        print(profile, "median first result (ms)", {m: round(ms(cases, profile, m), 2) for m in builds})
        for m in builds:
            def last_js_and_wasm_start(work, r):
                requests = cells[work, profile, m, r]["requests"]
                last_js = max(q["end"] for q in requests if q["path"].endswith(".js"))
                wasm, = [q for q in requests if q["path"].endswith(".wasm")]
                return last_js, wasm["start"]
            summaries = [[median(last_js_and_wasm_start(w, r)[index] for r in range(rounds))
                          for w in cases] for index in [0, 1]]
            print(m, "last JS response / start of guest Wasm fetch (ms)",
                  *(round(median(v), 2) for v in summaries))
        treatment = "external" if automatic else "application-preload" if app_preload else "application"
        for baseline in ["automatic" if automatic else "application" if app_preload else "external", "release", "bundled"]:
            pairs = [paired(w, profile, treatment, baseline) for w in cases]
            print(treatment, "/", baseline, f"{median(p[0] for p in pairs):.3f}×",
                  "individual intervals below / above parity", sum(p[2] < 1 for p in pairs), sum(p[1] > 1 for p in pairs))
    if args.plot:
        import matplotlib.pyplot as plt
        titles = {"limited": "40 ms latency · 10 Mbit/s", "loopback": "Loopback"}
        names = {"release": "Jco 1.13.0", "bundled": "Internal Oxc", "external": "External package",
                 "automatic": "Previous package", "application": "Application bundle", "application-preload": "Bundle + chunk preload"}
        labels = [names[m] for m in builds]
        fig, axes = plt.subplots(1, len(conditions), squeeze=False, figsize=(4.5*len(conditions), 3.5), layout="constrained")
        for ax, profile in zip(axes[0], conditions, strict=True):
            for i, mode in enumerate(builds):
                vals = [median(times(w, profile, mode)) for w in cases]
                ax.scatter(vals, [i]*len(vals), color="#2c7d82", alpha=.55, s=25)
                ax.plot(median(vals), i, "|", color="#202b3b", ms=17, mew=2)
            ax.set_yticks(range(len(labels)), labels)
            ax.set_title(titles[profile])
            ax.set_xlabel("First result (ms)")
            ax.invert_yaxis()
            ax.set_xlim(left=0)
            ax.grid(axis="x", alpha=.2)
        fig.savefig(args.plot, dpi=160)
    raise SystemExit(0)

print("Static module footprints. Columns give modules, JS bytes and sum of gzipped bytes.")
for mode, prefix in [("external", "/runtime/"), ("grouped", "/grouped/")]:
    demos = set()
    for w in cases:
        paths = [p for p in run["expected"][w][mode]["requests"] if p.startswith(prefix)]
        demos.add(footprint(paths))
    assert len(demos) == 1
    print(mode, "demo runtime", next(iter(demos)))
    print(mode, probe + " only", footprint(run["footprints"][mode]["intrinsics/" + probe]))

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
              for w in cases] + [probe.capitalize() + " only"]
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
