"""Render the binding-optimization measurements into the README."""
from collections import defaultdict
from hashlib import sha256
import json
from pathlib import Path
from statistics import median

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

bench = Path(__file__).resolve().parent
results = bench / "results"
inventory = (results / "candidate-sizes.json").read_bytes()
sizes = json.loads(inventory)
run = json.loads((results / "candidate-browser.json").read_text())
if run["sizesSha256"] != sha256(inventory).hexdigest() or run["candidate"] != sizes["candidate"]:
    raise ValueError("Timing samples and assets come from different builds")
reference = sizes.get("reference")
if reference != run.get("reference"):
    raise ValueError("Reference timings and generated assets differ")
if run["candidate"]["dirty"] or (reference and reference["dirty"]):
    raise ValueError("Publish measurements from a committed generator")

focus = {
    "attribute-churn": ("per setAttribute()", "Attribute write", "µs"),
    "canvas-draw": ("per fill_rect()", "Canvas fillRect", "µs"),
    "canvas-pixels": ("getImageData(): µs/call", "Canvas pixel read", "µs"),
    "dom-query": ("individual: µs/element", "DOM ID lookup", "µs"),
    "dom-traversal": ("traverse (total)", "Tree traversal", "ms"),
    "string-marshalling": ("get 1024 B", "Read 1 KiB string", "µs"),
    "table-update": ("create: total ms", "Table creation", "ms"),
}
languages = {"c": "C", "cpp": "C++", "rust": "Rust"}
shims = {"C++ emscripten": "Embind", "C++ em-js": "EM_JS", "Rust wasm-bindgen": "wasm-bindgen"}
times, loads = defaultdict(dict), defaultdict(dict)
for sample in run["samples"]:
    demo, impl, n = sample["demo"], sample["implementation"], sample["round"]
    for metric, value in sample["seconds"].items():
        times[demo, impl, metric][n] = value
    if sample["loadMs"] is not None:
        loads[demo, impl][n] = sample["loadMs"]
rounds = set(range(1, run["rounds"] + 1))
if any(set(samples) != rounds for samples in [*times.values(), *loads.values()]):
    raise ValueError("Missing rounds")

def time(demo, impl, metric):
    return median(times[demo, impl, metric].values())

def quantile(values, q):
    ordered = sorted(values)
    pos = (len(ordered) - 1) * q
    i = int(pos)
    return ordered[i] + (ordered[min(i + 1, len(ordered) - 1)] - ordered[i]) * (pos - i)

def compare(demo, lang, metric):
    cand, base, main = [time(demo, f"{lang} {v}", metric) for v in ("candidate", "baseline", "main")]
    available = [(time(demo, impl, metric), title) for impl, title in shims.items() if (demo, impl, metric) in times]
    shim, name = min(available, default=(None, "—"))
    return cand, base, main, shim, name

rows, baseline_ratios, shim_ratios, main_ratios = [], [], [], []
for demo, (metric, label, unit) in focus.items():
    for lang, title in languages.items():
        cand, base, main, shim, name = compare(demo, lang, metric)
        scale = 1000 if unit == "ms" else 1_000_000
        baseline_ratios.append(cand / base)
        main_ratios.append(cand / main)
        shim_ratios.append(cand / shim)
        rows.append([label, title, unit, *(f"{v * scale:,.2f}" for v in (base, main, cand)),
                     f"{cand / base:.2f}×", name, f"{shim * scale:,.2f}", f"{cand / shim:.2f}×"])

fig, (left, right) = plt.subplots(1, 2, figsize=(10, 4.6), layout="constrained", sharey=True)
for ax, ratios, target, title in [(left, baseline_ratios, 1, "Time relative to jco 1.13.0"),
                                  (right, shim_ratios, 10, "Time relative to fastest compiled shim")]:
    for i, (lang, color) in enumerate(zip(languages.values(), ["#067c77", "#c46320", "#474dac"])):
        ax.scatter(ratios[i::3], [j + (i-1)*0.21 for j in range(len(focus))], color=color, label=lang, s=34)
    ax.axvline(target, color="#515151", linestyle="--", label=f"{target}× target")
    ax.grid(axis="x", alpha=.2)
    ax.set_xlim(left=0)
    ax.set_xlabel("Median time ratio (lower is faster)")
    ax.set_title(title, fontsize=11, loc="left")
    ax.legend(fontsize=8, ncol=2)
left.set_yticks(range(len(focus)), [op for _, op, _ in focus.values()])
left.invert_yaxis()
fig.savefig(results / "candidate-runtime.png", dpi=155)
plt.close(fig)

lines = []
def para(s):
    lines.extend([s, ""])

def table(headers, rows):
    lines.extend(["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"])
    lines.extend("| " + " | ".join(row) + " |" for row in rows)
    lines.append("")

commit = run["candidate"]["commit"]
para("## Optimized browser bindings")
para(f"The candidate uses js-component-bindgen’s internal Oxc bundler and the checked jco-cm-runtime. "
     "For eligible single-instance, synchronous components, a host import reuses the caller’s task. "
     "Components with async operations, cross-component resource transfers or call tracking keep the general adapter. "
     f"[Jco commit `{commit[:9]}`](https://github.com/vados-cosmonic/jco/commit/{commit})")
para(f"All Jco builds used the same guest binaries. Each value is the median of "
     f"{run['rounds']} fresh-page samples with one warm-up per page. The run collected {len(run['samples'])} "
     f"samples on {run['date'][:10]} with {run['browser']} on {run['cpu']}.")
para(f"The candidate finished within **10× of the fastest available compiled shim in "
     f"{sum(r <= 10 for r in shim_ratios)}/{len(rows)}** headline comparisons. It matched or beat "
     f"**1.13.0 in {sum(r <= 1 for r in baseline_ratios)}/{len(rows)}** and **stock main in "
     f"{sum(r <= 1 for r in main_ratios)}/{len(rows)}**. The strictest shim comparison selects the lowest "
     "median among Embind, EM_JS and wasm-bindgen for each operation, including shims written in a different guest language. "
     "The phase tables in the original comparison describe workload differences and include raw JavaScript.")
para("![Candidate runtime relative to the two targets by operation and language](web/bench/results/candidate-runtime.png)")
table(["Operation", "Guest", "Unit", "1.13.0", "Stock main", "Candidate", "Candidate / 1.13.0",
       "Fastest shim", "Shim time", "Candidate / shim"], rows)
if reference:
    ref = reference["commit"]
    para("### Change from the previous branch revision")
    para("Both revisions ran on the same guest binaries in the same browser session. Each cell divides "
         "the candidate median by the previous revision’s median. Parentheses count the rounds in which the candidate finished faster. "
         f"[Previous Jco revision `{ref[:9]}`](https://github.com/vados-cosmonic/jco/commit/{ref})")
    comparisons = [(demo, metric, label) for demo, (metric, label, _) in focus.items()]
    comparisons += [("string-marshalling", metric, metric) for metric in ("set 8 B", "get 8 B")]
    def paired_change(demo, lang, metric):
        current = times[demo, f"{lang} candidate", metric]
        previous = times[demo, f"{lang} reference", metric]
        faster = sum(current[n] < previous[n] for n in rounds)
        return f"{median(current.values()) / median(previous.values()):.2f}× ({faster}/{len(rounds)})"

    table(["Operation", *languages.values()], [
        [label, *[paired_change(demo, lang, metric) for lang in languages]]
        for demo, metric, label in comparisons
    ])
phase_rows, phase_baseline, phase_shim, misses = [], [], [], []
for demo in focus:
    for metric in dict.fromkeys(m for d, i, m in times if d == demo and i == "c candidate"):
        for lang, title in languages.items():
            if (demo, f"{lang} candidate", metric) not in times:
                continue
            cand, base, main, shim, name = compare(demo, lang, metric)
            ratio = lambda den: f"{cand / den:.2f}×" if den else "—"
            if base:
                phase_baseline.append(cand / base)
            if shim:
                phase_shim.append(cand / shim)
                if cand > 10 * shim:
                    misses.append([demo, metric, title, name, f"{cand / shim:.2f}×"])
            unit = "ms" if "total" in metric or metric == "build" else "µs"
            duration = cand * (1000 if unit == "ms" else 1_000_000)
            phase_rows.append([demo, metric.replace("|", r"\|"), title, f"{duration:,.2f} {unit}", ratio(base), ratio(main), name, ratio(shim)])
para(f"Across all reported phases and string lengths, {sum(v <= 10 for v in phase_shim)}/{len(phase_shim)} "
     f"comparable candidate medians were within 10× of the fastest compiled shim and "
     f"{sum(v <= 1 for v in phase_baseline)}/{len(phase_baseline)} matched or beat 1.13.0. "
     "Totals and their subphases overlap. Each ratio compares the same phase on both sides.")
if misses:
    table(["Phases above 10×", "Phase", "Guest", "Shim", "Candidate / shim"], misses)
para("The bulk DOM query returns a live collection to Embind, which discards it. The component host materializes "
     "the collection with `Array.from`, then the bindings lower every element into a WIT resource handle. "
     "The ratio includes that difference in work. [Embind loop](cpp/dom-query/emscripten/main.cpp) · "
     "[Component host](web/host/web-host.js) · [C guest loop](c/dom-query/main.c)")
para("<details><summary>All timed phases and string lengths</summary>")
table(["Demo", "Phase", "Guest", "Candidate time", "Candidate / 1.13.0", "Candidate / main", "Fastest shim", "Candidate / shim"], phase_rows)
para("</details>")
paired = [c["variants"] for c in sizes["components"]]
def payload(files, field, suffix):
    return sum(a[field] for a in files if a["path"].endswith(suffix)) / 1024
def asset_median(version, field, suffix=""):
    return median(payload(v[version], field, suffix) for v in paired)
para("### Payload and startup")
para(f"Payload medians cover {len(paired)} component inputs. Compression is per file. Startup is the median "
     "of the 21 per-workload and guest medians, from dynamic import through initialization, with browser caching disabled.")
table(["Build", "JS (KiB)", "Core Wasm (KiB)", "Total (KiB)", "Gzip (KiB)", "Brotli (KiB)", "Startup (ms)"], [
    [label, *[f"{asset_median(v, field, suffix):,.1f}" for field, suffix in
              [("bytes", ".js"), ("bytes", ".wasm"), ("bytes", ""), ("gzip", ""), ("brotli", "")]],
     f"{median(median(loads[d, f'{lang} {v}'].values()) for d in focus for lang in languages):.2f}"]
    for v, label in [("baseline", "1.13.0"), ("main", "Stock main"), ("candidate", "Candidate")]
])
para("<details><summary>Candidate startup and run-to-run variation by workload</summary>")
table(["Operation", "Guest", "Startup median (ms)", "Warm phase p25", "Warm phase p50", "Warm phase p75", "Phase unit"], [
    [label, title, f"{median(loads[demo, f'{lang} candidate'].values()):.2f}",
     *[f"{v * (1000 if unit == 'ms' else 1_000_000):,.2f}" for v in
       [quantile(times[demo, f"{lang} candidate", metric].values(), q) for q in (.25, .5, .75)]], unit]
    for demo, (metric, label, unit) in focus.items() for lang, title in languages.items()
])
para("</details>")
para("[Raw browser timings](web/bench/results/candidate-browser.json) · "
     "[File sizes, digests and generator revision](web/bench/results/candidate-sizes.json)")
para("### Reproduce the candidate run")
para("Run the dependency installation, main setup and size commands in [Reproduce the comparison](#reproduce-the-comparison), "
     "then run the following from the repository root. Cargo uses the Jco checkout’s pinned toolchain and lockfile.")
reference_setup = (
    f"git -C ../jco-candidate worktree add --detach ../jco-reference {reference['commit']}\n"
    "node web/bench/candidate.mjs --reference ../jco-reference\n" if reference else ""
)
para(f"""```sh
git clone https://github.com/vados-cosmonic/jco ../jco-candidate
git -C ../jco-candidate checkout {commit}
node web/bench/candidate.mjs ../jco-candidate
{reference_setup}CHROME_BIN=/path/to/chrome BENCH_CANDIDATE=1 ROUNDS={run['rounds']} node web/bench/browser.mjs
python3 web/bench/candidate-report.py
```""")
readme = bench.parents[1] / "README.md"
text = readme.read_text()
a, b = "<!-- candidate:start -->", "<!-- candidate:end -->"
if a not in text:
    text = text.replace("<!-- benchmark:start -->", a + "\n" + b + "\n\n<!-- benchmark:start -->", 1)
readme.write_text(text[:text.index(a)] + a + "\n\n" + "\n".join(lines) + "\n" + text[text.index(b):])
