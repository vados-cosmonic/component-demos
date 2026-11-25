"""Regenerate the README snapshot and figures from the two benchmark JSON files."""
from collections import defaultdict
from hashlib import sha256
import json
from pathlib import Path
from statistics import median, quantiles

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import Normalize
from math import log2

BENCH = Path(__file__).resolve().parent
RESULTS = BENCH / "results"
runtime = json.loads((RESULTS / "browser.json").read_text())
size_bytes = (RESULTS / "sizes.json").read_bytes()
sizes = json.loads(size_bytes)
if sha256(size_bytes).hexdigest() != runtime["sizesSha256"]:
    raise SystemExit("Browser samples and size inventory come from different runs")
baseline = sizes["baseline"]
commit = sizes["main"]
pin = json.loads((BENCH / "pin.json").read_text())
if commit != pin["commit"]:
    raise SystemExit("The snapshot uses a different main commit than pin.json")

# One readily interpreted operation per workload for the overview.
focus = {
    "attribute-churn": ("per setAttribute()", "Attribute write", "µs"),
    "canvas-draw": ("per fill_rect()", "Canvas fillRect", "µs"),
    "canvas-pixels": ("getImageData(): µs/call", "Canvas pixel read", "µs"),
    "dom-query": ("individual: µs/element", "DOM ID lookup", "µs"),
    "dom-traversal": ("traverse (total)", "Tree traversal", "ms"),
    "string-marshalling": ("get 1024 B", "Read 1 KiB string", "µs"),
    "table-update": ("create: total ms", "Table creation", "ms"),
}
units = {"ms": 1000, "µs": 1_000_000}
languages = {"c": "C", "cpp": "C++", "rust": "Rust"}
implementations = ["JS", "C++ emscripten", "C++ em-js", "Rust wasm-bindgen"] + [
    f"{lang} {version}" for lang in languages for version in ("baseline", "main")
]
display = {"JS": "JS", "C++ emscripten": "Embind", "C++ em-js": "EM_JS", "Rust wasm-bindgen": "wasm-bindgen"}
for lang, title in languages.items():
    display[f"{lang} baseline"] = f"{title} {baseline}"
    display[f"{lang} main"] = f"{title} main"

values = defaultdict(list)
loads = defaultdict(list)
metrics = defaultdict(dict)
for sample in runtime["samples"]:
    demo, impl = sample["demo"], sample["implementation"]
    for metric, seconds in sample["seconds"].items():
        values[demo, impl, metric].append(seconds)
        metrics[demo][metric] = True
    if sample["loadMs"] is not None:
        loads[demo, impl].append(sample["loadMs"])
if any(len(v) != runtime["rounds"] for v in [*values.values(), *loads.values()]):
    raise SystemExit("A measurement is missing samples")

def total(files, field="bytes"):
    return sum(f[field] for f in files)

def kib(n):
    return f"{n / 1024:,.1f}"

def number(x):
    return f"{x:.3g}" if x < 1 else f"{x:,.2f}"

def ratio(demo, lang):
    metric = focus[demo][0]
    return median(values[demo, f"{lang} main", metric]) / median(values[demo, f"{lang} baseline", metric])

lines = []
def paragraph(s):
    lines.extend([s, ""])

def table(headers, rows):
    def row(cells):
        return "| " + " | ".join(map(str, cells)) + " |"
    lines.extend([row(headers), row(["---"] + ["---:"] * (len(headers) - 1))])
    lines.extend(row(cells) for cells in rows)
    lines.append("")

def details(title):
    paragraph(f"<details><summary>{title}</summary>")

def timing_row(demo, metric, label, unit):
    cells = []
    for impl in implementations:
        samples = values.get((demo, impl, metric))
        cells.append(number(median(samples) * units[unit]) if samples else "—")
    return [f"{label} ({unit})", *cells]

paragraph("## Browser performance")
paragraph(f"**jco {baseline} vs. main at `{commit[:8]}`** · {runtime['date'][:10]} · "
          f"{runtime['browser']} · {runtime['cpu']} · {runtime['os']} · Node {runtime['node']}. "
          f"[Upstream commit](https://github.com/bytecodealliance/jco/commit/{commit}) · "
          f"[Transpiler build](https://github.com/bytecodealliance/jco/actions/runs/{pin['run']})")
changes = [(ratio(demo, lang), demo, lang) for demo in focus for lang in languages]
largest, demo, lang = max(changes)
paragraph(f"Across the seven operations below and three guest languages, main took longer in "
          f"**{sum(r > 1 for r, _, _ in changes)} of {len(changes)}** median comparisons. "
          f"The highest ratio was **{largest:.2f}×** for the {languages[lang]} guest in `{demo}`.")
large_string_changes = []
for lang in languages:
    key = "get 262144 B"
    old = median(values["string-marshalling", f"{lang} baseline", key])
    new = median(values["string-marshalling", f"{lang} main", key])
    large_string_changes.append(100 * (new / old - 1))
paragraph(f"For 256 KiB string reads, the median time on main changed by {min(large_string_changes):+.0f}% "
          f"to {max(large_string_changes):+.0f}% across the three guest languages. The phase tables below include every tested string size.")
paragraph(f"Each cell is the median of {runtime['rounds']} fresh-page samples. "
          f"The chart divides main’s median time by {baseline}’s for the same guest and operation. "
          "A value below 1× means main finished faster.")
fig, ax = plt.subplots(figsize=(7.1, 4.4), layout="constrained")
ratios = [[ratio(demo, lang) for lang in languages] for demo in focus]
limit = max(0.3, max(abs(log2(x)) for row in ratios for x in row))
ax.imshow([[log2(x) for x in row] for row in ratios], cmap="RdBu_r", norm=Normalize(-limit, limit), aspect="auto", alpha=0.65)
ax.set_xticks(range(3), languages.values())
ax.xaxis.tick_top()
ax.set_yticks(range(len(focus)), [v[1] for v in focus.values()])
ax.tick_params(length=0, pad=8)
for i, row in enumerate(ratios):
    for j, x in enumerate(row):
        ax.text(j, i, f"{x:.2f}×", ha="center", va="center", fontweight="bold")
ax.set_title(f"Browser time on main relative to jco {baseline}", loc="left", pad=16)
fig.savefig(RESULTS / "runtime.png", dpi=160)
plt.close(fig)
paragraph("![Median time on main divided by baseline time for seven operations and three guest languages](web/bench/results/runtime.png)")
headers = ["Operation"] + [display[i] for i in implementations]
table(headers, [timing_row(demo, *cfg) for demo, cfg in focus.items()])
paragraph("Embind and EM_JS are the C++ Emscripten variants. An em dash marks an unavailable combination. "
          "Across toolchains, the upstream implementations can do different amounts of work. For example, "
          "the JavaScript bulk DOM query obtains a live collection while the component host materializes a list.")

details("Run-to-run variation for the two jco versions")
paragraph("Each cell spans the 25th to 75th percentile of measured times, using linear interpolation between sorted samples.")
iqr_impls = [impl for impl in implementations if impl.endswith((" baseline", " main"))]
iqr_rows = []
for demo, (metric, label, unit) in focus.items():
    row = [f"{label} ({unit})"]
    for impl in iqr_impls:
        samples = values[demo, impl, metric]
        q1, _, q3 = quantiles(samples, n=4, method="inclusive") if len(samples) > 1 else samples * 3
        row.append(f"{number(q1 * units[unit])}–{number(q3 * units[unit])}")
    iqr_rows.append(row)
table(["Operation", *[display[i] for i in iqr_impls]], iqr_rows)
paragraph("</details>")

def string_chart():
    demo = "string-marshalling"
    lengths = sorted(int(metric.split()[1]) for metric in metrics[demo] if metric.startswith("get "))
    fig, axes = plt.subplots(2, 3, figsize=(9.8, 5.0), sharex=True, sharey=True, layout="constrained")
    for col, (lang, title) in enumerate(languages.items()):
        axes[0, col].set_title(title)
        for row, op in enumerate(("set", "get")):
            ax = axes[row, col]
            for version, name, color, marker in (("baseline", baseline, "#196477", "o"), ("main", "main", "#a74e23", "D")):
                times = [median(values[demo, f"{lang} {version}", f"{op} {n} B"]) * 1e6 for n in lengths]
                ax.plot(lengths, times, color=color, marker=marker, label=name)
            ax.set_xscale("log", base=2)
            ax.set_yscale("log")
            ax.grid(alpha=0.22)
            if col == 0:
                ax.set_ylabel(f"{op} (µs/call)")
            if row == 1:
                ax.set_xticks([8, 1024, 262144], ["8 B", "1 KiB", "256 KiB"])
    axes[0, 2].legend(frameon=False)
    fig.suptitle("DOM textContent across the component boundary", x=0.01, ha="left", fontweight="bold")
    fig.savefig(RESULTS / "strings.png", dpi=160)
    plt.close(fig)

string_chart()

details("All workload phases, per-call timings, and string transfer rates")
paragraph("Times come from the tables rendered by the demos and retain their original reporting precision. "
          "Effective string throughput uses the ASCII payload length divided by median call time (decimal MB/s).")
for demo in focus:
    paragraph(f"**{demo}**")
    if demo == "string-marshalling":
        paragraph("![Median DOM textContent set and get latency by payload length for each guest and jco version, on logarithmic axes](web/bench/results/strings.png)")
    rows = []
    for metric in metrics[demo]:
        is_total = "total" in metric or metric in ("build", "traverse (total)")
        rows.append(timing_row(demo, metric, metric.replace(": total ms", ", total").replace(": µs/call", "").replace(": µs/row", ", per row"), "ms" if is_total else "µs"))
        if demo == "string-marshalling":
            length = int(metric.split()[1])
            rates = []
            for impl in implementations:
                data = values.get((demo, impl, metric))
                rates.append(number(length / (median(data) * 1e6)) if data and median(data) else "—")
            rows.append([metric + " (MB/s)", *rates])
    table(headers, rows)
paragraph("</details>")

details("Module load and initialization, median milliseconds")
paragraph("Elapsed browser time for dynamic import through instantiation, with the shared demo host already loaded. "
          "The browser process is reused, each page has HTTP caching disabled, and assets are served uncompressed over loopback. "
          "These timings include scheduling and local requests. JS is already loaded by the harness.")
table(["Workload"] + [display[i] for i in implementations[1:]], [
    [demo] + [number(median(loads[demo, i])) if (demo, i) in loads else "—" for i in implementations[1:]] for demo in focus
])
paragraph("</details>")

details("Workload parameters and sampling")
table(["Workload", "Arguments"], [[d, ", ".join(f"`{k}={v}`" for k, v in p.items())] for d, p in runtime["workloads"].items()])
timed = [c for c in sizes["components"] if Path(c["input"]["path"]).parts[1] in focus
         and Path(c["input"]["path"]).stem == Path(c["input"]["path"]).parts[1].replace("-", "_")]
def matches_checked_in(asset):
    original = BENCH.parent / asset["path"].replace("/jco-baseline/", "/jco/")
    return original.is_file() and sha256(original.read_bytes()).hexdigest() == asset["sha256"]

matches = sum(all(matches_checked_in(a) for a in c["variants"]["baseline"]) for c in timed)
paragraph(f"The regenerated {baseline} runtime assets match the checked-in jco output byte for byte for "
          f"{matches} of the {len(timed)} timed components.")
paragraph("Each page runs one warm-up, clears the document and performance entries, and runs the same workload again on the "
          "initialized module. The runner rotates the implementation order each round and reverses traversal on alternating rounds. "
          "Browser timings cover the work instrumented inside the demos. Canvas timings measure the API calls, which can finish "
          "before painting. Native Firefox execution was outside this Chromium run. "
          "[Individual samples in seconds and load times in milliseconds](web/bench/results/browser.json)")
paragraph("</details>")

paragraph("## Module size")
components = sizes["components"]
diffs = [total(c["variants"]["main"], "gzip") - total(c["variants"]["baseline"], "gzip") for c in components]
paragraph(f"Across {len(components)} component inputs, the median change in gzip payload on main was "
          f"**{median(diffs)/1024:+.1f} KiB** per component (range {min(diffs)/1024:+.1f} to {max(diffs)/1024:+.1f} KiB). "
          "The payload sums the emitted JavaScript and external core Wasm files, including any Wasm inlined into JavaScript. "
          "Gzip level 9 and Brotli quality 11 are applied per file. Shared host code, HTML, type declarations and HTTP headers are excluded. "
          "The raw JavaScript reference lives in the demo page controller.")
def core_hashes(files):
    return sorted(f["sha256"] for f in files if f["path"].endswith(".wasm"))

if all(core_hashes(c["variants"]["baseline"]) == core_hashes(c["variants"]["main"]) for c in components):
    paragraph("All external core Wasm files match byte for byte between the two generators. "
              "The size differences come entirely from the emitted JavaScript.")
fig, axes = plt.subplots(1, 3, figsize=(10, 4.6), sharex=True, sharey=True, layout="constrained")
for ax, (lang, title) in zip(axes, languages.items()):
    for y, demo in enumerate(focus):
        c = next(c for c in components if c["input"]["path"] == f"{lang}/{demo}/native/{demo.replace('-', '_')}.wasm")
        old, new = (total(c["variants"][v], "gzip") / 1024 for v in ("baseline", "main"))
        ax.plot([old, new], [y, y], color="#a2acb6", zorder=1)
        ax.scatter(old, y, color="#196477", marker="o", label=baseline if y == 0 else None)
        ax.scatter(new, y, color="#a74e23", marker="D", label="main" if y == 0 else None)
    ax.set_title(title)
    ax.set_xlabel("KiB, gzip")
    ax.grid(axis="x", alpha=0.2)
axes[0].set_yticks(range(len(focus)), list(focus))
axes[0].invert_yaxis()
axes[0].set_xlim(left=0)
axes[-1].legend(loc="lower right", bbox_to_anchor=(1, 1.1), ncols=2, frameon=False)
fig.suptitle("Compressed module payload by guest language", x=0.01, ha="left", fontweight="bold")
fig.savefig(RESULTS / "payload.png", dpi=160)
plt.close(fig)
paragraph("![Gzip payload in KiB for the seven browser workloads, grouped by guest language](web/bench/results/payload.png)")

paragraph("**DOM traversal download size** in KiB, gzip. Each row compares implementations from one guest language.")
rows = []
for lang, title in languages.items():
    c = next(c for c in components if c["input"]["path"] == f"{lang}/dom-traversal/native/dom_traversal.wasm")
    row = [title, kib(c["input"]["gzip"])]
    row.extend(kib(total(c["variants"][v], "gzip")) for v in ("baseline", "main"))
    for directory in ("cpp/dom-traversal/emscripten", "cpp/dom-traversal/em-js", "rust/dom-traversal-wasm-bindgen"):
        assets = sizes["alternatives"].get(directory)
        row.append(kib(total(assets, "gzip")) if directory.startswith(lang + "/") and assets else "—")
    rows.append(row)
table(["Guest", "Native component", f"jco {baseline}", "jco main", "Embind", "EM_JS", "wasm-bindgen"], rows)

details("All component sizes, in KiB")
paragraph(f"Paired columns list **{baseline} / main**. Native is the original component binary. Core Wasm counts only separate .wasm files.")
rows = []
for c in components:
    path = Path(c["input"]["path"])
    lang, demo = path.parts[:2]
    name = f"{languages[lang]} {demo}"
    if "." in path.stem:
        name += f" ({path.stem})"
    pair = [c["variants"][v] for v in ("baseline", "main")]
    row = [name, kib(c["input"]["bytes"]), " / ".join(str(len(files)) for files in pair)]
    for ext in (".js", ".wasm"):
        row.append(" / ".join(kib(total([f for f in files if f["path"].endswith(ext)])) for files in pair))
    for field in ("bytes", "gzip", "brotli"):
        row.append(" / ".join(kib(total(files, field)) for files in pair))
    rows.append(row)
table(["Component", "Native", "Files", "JS", "Core Wasm", "Raw total", "Gzip", "Brotli"], rows)
paragraph("</details>")

details("Emscripten and wasm-bindgen payloads, in KiB")
rows = [[name, len(files), *[kib(total(files, f)) for f in ("bytes", "gzip", "brotli")]]
        for name, files in sizes["alternatives"].items()]
table(["Artifact directory", "Files", "Raw total", "Gzip", "Brotli"], rows)
paragraph("</details>")
paragraph("[Per-file byte counts and SHA-256 digests](web/bench/results/sizes.json)")

readme = BENCH.parents[1] / "README.md"
before, rest = readme.read_text().split("<!-- benchmark:start -->")
_, after = rest.split("<!-- benchmark:end -->")
readme.write_text(before + "<!-- benchmark:start -->\n\n" + "\n".join(lines) + "\n<!-- benchmark:end -->" + after)
