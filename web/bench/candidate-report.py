"""Render the binding-optimization measurements into the README."""
from collections import defaultdict
from hashlib import sha256
import json
from math import comb, isfinite
from pathlib import Path
from statistics import median

from startup_report import distributions, startup_intervals

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

bench = Path(__file__).resolve().parent
results = bench / "results"
inventory = (results / "candidate-sizes.json").read_bytes()
sizes = json.loads(inventory)
pin = json.loads((bench / "pin.json").read_text())
if pin["commit"] != sizes["main"]:
    raise ValueError("The candidate inventory uses a different upstream revision from pin.json")
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

paired_run = json.loads((results / "paired-browser.json").read_text())
if paired_run["sizesSha256"] != run["sizesSha256"] or paired_run["candidate"] != run["candidate"]:
    raise ValueError("Paired browser samples and candidate builds differ")
for path, digest in paired_run["sources"].items():
    if sha256((bench.parent / path).read_bytes()).hexdigest() != digest:
        raise ValueError("Paired browser source changed: " + path)
paired_samples = {}
for sample in paired_run["samples"]:
    key = (sample["demo"], sample["implementation"], sample["round"], sample["pass"])
    if key in paired_samples:
        raise ValueError("Repeated paired browser sample")
    paired_samples[key] = sample["seconds"]
if len(paired_samples) != len(focus) * len(languages) * 2 * paired_run["rounds"] * paired_run["passes"]:
    raise ValueError("Unexpected number of paired samples")
def paired_page_ratios(demo, lang, metric):
    result = []
    for n in range(1, paired_run["rounds"] + 1):
        ratios = []
        for visit in range(1, paired_run["passes"] + 1):
            baseline, candidate = [paired_samples[demo, f"{lang} {v}", n, visit][metric]
                                   for v in ("baseline", "candidate")]
            if baseline <= 0:
                raise ValueError(f"Cannot compare a zero baseline for {demo}/{lang}/{metric}")
            ratios.append(candidate / baseline)
        result.append(median(ratios))
    return result

def median_interval(pages):
    """Two-sided sign-test interval with at least 95% marginal coverage."""
    ordered = sorted(pages)
    n = len(ordered)
    tail = 0
    bounds = (0, float("inf"))
    for k in range((n + 1) // 2):
        tail += comb(n, k)
        if 40 * tail > 2**n:
            break
        bounds = ordered[k], ordered[-1 - k]
    return bounds

def interval_text(bounds):
    lo, hi = bounds
    return f"{lo:.3f}–{hi:.3f}×" if isfinite(hi) else "Unbounded"

paired_rows = []
paired_intervals = defaultdict(list)
paired_winners = 0
for demo, (metric, label, unit) in focus.items():
    for lang, title in languages.items():
        per_page = paired_page_ratios(demo, lang, metric)
        midpoint = median(per_page)
        paired_winners += midpoint <= 1
        paired_intervals[title].append((midpoint, quantile(per_page, .25), quantile(per_page, .75)))
        paired_rows.append([label, title, f"{midpoint:.2f}×",
                            f"{quantile(per_page, .25):.2f}–{quantile(per_page, .75):.2f}×",
                            interval_text(median_interval(per_page)),
                            f"{sum(v <= 1 for v in per_page)}/{len(per_page)}"])
all_paired = []
phase_bounds = {}
for demo in focus:
    for lang, title in languages.items():
        metrics = paired_samples[demo, f"{lang} baseline", 1, 1]
        for metric in metrics:
            pages = paired_page_ratios(demo, lang, metric)
            phase_bounds[demo, title, metric] = median_interval(pages)
            all_paired.append((median(pages), demo, title, metric, sum(r <= 1 for r in pages)))
paired_medians = {(demo, guest, metric): value for value, demo, guest, metric, _ in all_paired}
slow_paired = sorted((entry for entry in all_paired if entry[0] > 1), reverse=True)

lines = []
def para(s):
    lines.extend([s, ""])

def table(headers, rows):
    lines.extend(["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"])
    lines.extend("| " + " | ".join(row) + " |" for row in rows)
    lines.append("")

commit = run["candidate"]["commit"]
para("## Optimized browser bindings")
para(f"The branch uses js-component-bindgen’s internal Oxc bundler and the checked jco-cm-runtime. "
     f"[Measured Jco commit `{commit[:9]}`](https://github.com/vados-cosmonic/jco/commit/{commit}) · "
     "[Canvas host comparison](#canvas-pixel-transfers-with-the-same-guest-binary) · "
     "[Payload and startup](#payload-and-startup) · [Reproduction commands](#reproduce-the-candidate-run)")
para(f"All Jco builds used the same guest binaries. Each value is the median of "
     f"{run['rounds']} fresh-page samples with one warm-up per page. The run collected {len(run['samples'])} "
     f"samples on {run['date'][:10]} with {run['browser']} on {run['cpu']}.")
para(f"Stock main is pinned to `{pin['commit'][:9]}`. "
     f"[Upstream source](https://github.com/bytecodealliance/jco/commit/{pin['commit']}) · "
     f"[Transpiler CI build](https://github.com/bytecodealliance/jco/actions/runs/{pin['run']})")
para(f"The candidate finished within **10× of the fastest available compiled shim in "
     f"{sum(r <= 10 for r in shim_ratios)}/{len(rows)}** headline comparisons. The largest ratio was **{max(shim_ratios):.2f}×**. "
     "On separate fresh pages it matched or beat "
     f"**1.13.0 in {sum(r <= 1 for r in baseline_ratios)}/{len(rows)}** and **stock main in "
     f"{sum(r <= 1 for r in main_ratios)}/{len(rows)}**. On the same warmed page it matched or beat "
     f"**1.13.0 in {paired_winners}/{len(paired_rows)}** headline cases and {len(all_paired) - len(slow_paired)}/{len(all_paired)} "
     "across all phases. The shim comparison selects the lowest "
     "median among Embind, EM_JS and wasm-bindgen for each operation, including shims written in a different guest language. "
     "The phase tables in the original comparison describe workload differences and include raw JavaScript.")
para("![Candidate runtime relative to the two targets by operation and language](web/bench/results/candidate-runtime.png)")
table(["Operation", "Guest", "Unit", "1.13.0", "Stock main", "Candidate", "Candidate / 1.13.0",
       "Fastest shim", "Shim time", "Candidate / shim"], rows)
shim_guests = {"C++ emscripten": "cpp", "C++ em-js": "cpp", "Rust wasm-bindgen": "rust"}
matched_shims, shim_by_guest = [], []
for demo, (metric, label, _) in focus.items():
    row = [label]
    for impl, lang in shim_guests.items():
        if (demo, impl, metric) in times:
            value = time(demo, f"{lang} candidate", metric) / time(demo, impl, metric)
            matched_shims.append(value)
            row.append(f"{value:.2f}×")
        else:
            row.append("—")
    shim_by_guest.append(row)
para(f"Comparing implementations in the same language, the branch stayed within 10× in "
     f"**{sum(value <= 10 for value in matched_shims)}/{len(matched_shims)}** available headline comparisons. "
     "Each cell divides the branch’s median by that shim’s median. A dash means the demo has no implementation "
     "for that binding. The demos supply compiled shims for C++ and Rust.")
table(["Operation", "C++ / Embind", "C++ / EM_JS", "Rust / wasm-bindgen"], shim_by_guest)
para("<details><summary>How the synchronous bindings work</summary>")
para("Eligible single-instance, synchronous components reuse the caller’s task for host imports. "
     "The adapter keeps direct references to its task stack and instance flags and checks for store interruptions. "
     "Oxc removes the asynchronous import fallback and the subtask constructor, which these imports never use. The generator skips asynchronous wrappers for synchronous allocators "
     "and post-return hooks. Standalone modules also omit suspension markers on core imports.")
para("During a guest allocation, the checked runtime clears the instance’s may-leave flag and restores it on return or throw. "
     "Allocators in components with context-slot operations use the general guard to supply fresh slots for each call. "
     "The adapter lifts short ASCII strings four bytes at a time. Synchronous UTF-8 results of 256 to 262,144 code units "
     "can reuse a per-instance byte buffer capped at 256 KiB. The runtime encodes there before requesting the exact guest allocation. "
     "Nested calls and larger results use the ordinary encoder.")
para("Resource drops check the instance flag and record traps. When lifting a borrowed host resource, "
     "the adapter validates the handle and reads its 32-bit representation directly. Imported host resources with automatically "
     "assigned representations use their guest handle as an array index. Explicit host representations and shared tables use a "
     "representation map. Components with async operations, cross-component resource transfers or call tracking use the general adapter.")
para("The preceding run measures the change from removing the subtask constructor from synchronous components. "
     "[Archived report](https://github.com/vados-cosmonic/component-demos/blob/255eca61b14b5ab63567da558b5f561149cc5163/README.md#change-from-the-previous-branch-revision)")
para("</details>")
if reference:
    ref = reference["commit"]
    para("### Change from the previous branch revision")
    para("Both revisions ran on the same guest binaries in the same browser session. Each cell divides "
         "the candidate median by the previous revision’s median. Parentheses count the rounds in which the candidate finished faster. "
         f"[Compare `{ref[:9]}` and `{commit[:9]}`](https://github.com/vados-cosmonic/jco/compare/{ref}...{commit})")
    unchanged = {}
    js_deltas = []
    gzip_deltas = []
    for component in sizes["components"]:
        current, previous = [component["variants"][version] for version in ("candidate", "reference")]
        js_deltas.append(sum(a["bytes"] for a in current if a["path"].endswith(".js"))
                         - sum(a["bytes"] for a in previous if a["path"].endswith(".js")))
        gzip_deltas.append(sum(a["gzip"] for a in current) - sum(a["gzip"] for a in previous))
        path = Path(component["input"]["path"])
        lang, demo = path.parts[:2]
        if demo not in focus or path.name != demo.replace("-", "_") + ".wasm":
            continue
        outputs = [{Path(asset["path"]).name: asset["sha256"] for asset in component["variants"][version]}
                   for version in ("candidate", "reference")]
        unchanged[demo, lang] = outputs[0] == outputs[1]
    if len(unchanged) != len(focus) * len(languages):
        raise ValueError("No corresponding generated files for a headline workload")
    cold_ratios = [median(loads[demo, f"{lang} candidate"].values()) / median(loads[demo, f"{lang} reference"].values())
                   for demo, lang in unchanged]
    para(f"Generated JavaScript was smaller for {sum(v < 0 for v in js_deltas)}/{len(js_deltas)} inputs. "
         f"The median per-input change was {median(js_deltas):+,.0f} bytes of JavaScript and {median(gzip_deltas):+,.0f} bytes "
         f"of total gzip payload. Across the {len(cold_ratios)} timed guest and workload combinations, the median ratio of "
         f"candidate to previous startup time was {median(cold_ratios):.2f}×.")
    assets = {asset["path"]: asset["bytes"] for component in sizes["components"]
              for version in ("reference", "candidate") for asset in component["variants"][version]}
    measured = defaultdict(dict)
    for sample in run["samples"]:
        label = sample["implementation"].split()
        if label[-1] not in ("candidate", "reference"):
            continue
        lang, version = label
        case = sample["demo"], lang
        path = Path(lang) / sample["demo"] / ("jco-" + version)
        page = measured[case, version]
        if sample["round"] in page:
            raise ValueError("Duplicate startup measurement for " + str(path))
        page[sample["round"]] = (sample["loadMs"], *startup_intervals(sample, assets, path))
    if any(set(measured[case, version]) != rounds for case in unchanged for version in ("candidate", "reference")):
        raise ValueError("Missing current or previous startup measurements")
    stage_changes = []
    for column, stage in enumerate(("Import to ready", "Import to JS response end", "JS end to first Wasm request",
                                    "First Wasm request to last Wasm response", "Last Wasm response to ready")):
        pairs = [(median(row[column] for row in measured[case, "reference"].values()),
                  median(row[column] for row in measured[case, "candidate"].values())) for case in unchanged]
        before, after = zip(*pairs)
        stage_changes.append([stage, f"{median(before):.2f}", f"{median(after):.2f}",
                              f"{median(new - old for old, new in pairs):+.2f}",
                              f"{sum(new < old for old, new in pairs)}/{len(pairs)}"])
    para("Both branch revisions also ran with their default output and caching disabled. The change column "
         "takes the difference for each guest and workload first, then the median of those differences.")
    table(["Startup interval", "Previous (ms)", "Candidate (ms)", "Median change (ms)", "Faster workloads"], stage_changes)
    controls = [time(demo, lang + " candidate", focus[demo][0]) / time(demo, lang + " reference", focus[demo][0])
                for (demo, lang), identical in unchanged.items() if identical]
    if controls:
        para(f"The generated JavaScript and Wasm were byte-identical for {len(controls)}/{len(unchanged)} headline cases. "
             f"On separate fresh pages, the ratios for those identical builds ranged from {min(controls):.2f}× to "
             f"{max(controls):.2f}×. That spread measures run-to-run variation on this machine. "
             "[Output hashes](web/bench/results/candidate-sizes.json)")
    comparisons = [(demo, metric, label) for demo, (metric, label, _) in focus.items()]
    comparisons += [("dom-query", "bulk: total ms", "Bulk DOM query"),
                    ("dom-traversal", "build", "Tree construction")]
    comparisons += [("string-marshalling", metric, metric) for metric in ("set 8 B", "get 8 B", "get 128 B", "get 16384 B", "get 262144 B")]
    def paired_change(demo, lang, metric):
        current = times[demo, f"{lang} candidate", metric]
        previous = times[demo, f"{lang} reference", metric]
        faster = sum(current[n] < previous[n] for n in rounds)
        return f"{median(current.values()) / median(previous.values()):.2f}× ({faster}/{len(rounds)})"

    table(["Operation", *languages.values()], [
        [label, *[paired_change(demo, lang, metric) for lang in languages]]
        for demo, metric, label in comparisons
    ])
para("### Warm 1.13.0 comparison on the same page")
para(f"For each guest and workload, both builds run once to warm up, then {paired_run['passes']} times each on the same page. "
     "Each pair alternates which build runs first. The runner clears the DOM and performance entries before every call. "
     f"It repeats this on {paired_run['rounds']} fresh pages. Each page contributes the median of its candidate / 1.13.0 "
     f"ratios. The median across pages was at or below 1× for **{paired_winners}/{len(paired_rows)}** headline cases. "
     "[Raw paired timings](web/bench/results/paired-browser.json)")
fig, ax = plt.subplots(figsize=(8.5, 4.8), layout="constrained")
for (guest, observations), offset, color, marker in zip(paired_intervals.items(), (-.23, 0, .23),
                                                        ("#005f73", "#a34b13", "#614a8d"), ("o", "s", "D")):
    centers, left, right = zip(*observations)
    ax.errorbar(centers, [i + offset for i in range(len(focus))],
                xerr=[[c - lo for c, lo in zip(centers, left)], [hi - c for c, hi in zip(centers, right)]],
                fmt=marker, markersize=4, capsize=2, color=color, label=guest)
ax.set_yticks(range(len(focus)), [label for _, label, _ in focus.values()])
ax.invert_yaxis()
ax.axvline(1, linestyle="--", color="#545454", linewidth=1, label="1.13.0")
ax.set_xlim(left=0)
ax.set_xlabel("Candidate time / 1.13.0 time (lower is faster)")
ax.grid(axis="x", alpha=.18)
ax.legend(ncols=4, loc="lower center", bbox_to_anchor=(.5, 1))
fig.savefig(results / "paired-runtime.png", dpi=155)
plt.close(fig)
para("![Median paired time ratios by workload and guest, with bars spanning the middle half of page ratios]"
     "(web/bench/results/paired-runtime.png)")
para("The middle 50% describes variation between pages. The median interval uses a two-sided sign test over "
     "independent page medians at the 95% level for each phase individually. Measurements on this CPU and browser "
     "can share machine load across pages.")
table(["Operation", "Guest", "Candidate / 1.13.0", "Middle 50% of page ratios", "95% median interval",
       "Pages at or below 1×"], paired_rows)
above_baseline = sum(lo > 1 for lo, _ in phase_bounds.values())
para(f"Across all {len(all_paired)} reported phases and string lengths, the same-page comparison matched or beat "
     f"1.13.0 in **{len(all_paired) - len(slow_paired)}/{len(all_paired)}** cases. The median interval lay entirely "
     f"above 1× in **{above_baseline}/{len(all_paired)}** cases. Totals and subphases overlap.")
if slow_paired:
    table(["Slower paired phase", "Guest", "Metric", "Candidate / 1.13.0", "95% median interval", "Pages at or below 1×"],
          [[demo, guest, metric, f"{ratio:.3f}×", interval_text(phase_bounds[demo, guest, metric]), f"{wins}/{paired_run['rounds']}"]
           for ratio, demo, guest, metric, wins in slow_paired])
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
            phase_rows.append([demo, metric.replace("|", r"\|"), title, f"{duration:,.2f} {unit}", ratio(base),
                               f"{paired_medians[demo, title, metric]:.2f}×", ratio(main), name, ratio(shim)])
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
control_path = results / "dom-control-browser.json"
if control_path.exists():
    control = json.loads(control_path.read_text())
    if control["sizesSha256"] != run["sizesSha256"] or control["candidate"] != run["candidate"]:
        raise ValueError("Rerun BENCH_DOM_CONTROL=1 for this candidate")
    for path, digest in control["sources"].items():
        if sha256((bench.parent / path).read_bytes()).hexdigest() != digest:
            raise ValueError(f"DOM control source has changed: {path}")
    control_rounds = set(range(1, control["rounds"] + 1))
    durations = defaultdict(dict)
    control_loads = defaultdict(dict)
    for sample in control["samples"]:
        group = control_loads[sample["demo"], sample["implementation"]]
        load = sample["loadMs"]
        if sample["round"] in group or not isfinite(load) or load <= 0:
            raise ValueError("Invalid DOM control startup measurement")
        group[sample["round"]] = load
        for metric, seconds in sample["seconds"].items():
            key = (sample["demo"], sample["implementation"], metric)
            if sample["round"] in durations[key]:
                raise ValueError(f"Repeated DOM control sample for {key}")
            durations[key][sample["round"]] = seconds
    para("### DOM bindings with identical guest code")
    para(f"These {len(control['samples'])} fresh-page samples compare each language’s exact core Wasm binary with "
         "each set of bindings in the table. The direct JS shim calls the same DOM host, puts owned handles in guest memory "
         "and recycles them on guest drops. It implements the synchronous imports used by these guests. Jco also "
         "provides Canonical ABI checks, task tracking and instance shutdown. "
         "[Direct shim](web/bench/dom-core-shim.mjs) · [Raw timings and correctness checks](web/bench/results/dom-control-browser.json)")
    query = control["workloads"]["dom-query"]
    traversal = control["workloads"]["dom-traversal"]
    nodes = sum(traversal["numChildren"] ** level for level in range(traversal["depth"] + 1))
    para(f"The bulk query copies {query['numElements']:,} handles per call, {query['iters']} times. "
         f"Each traversal visits {nodes:,} nodes. The runner checks the rendered fixture or node count for "
         "each guest and verifies list counts and handle release for the direct shim after warm-up and measurement.")
    matched_rows, bulk_ratios = [], []
    matched_plot = defaultdict(list)
    previous = ["reference"] if control.get("reference") else []
    for demo, metric, title in [("dom-query", "individual: total ms", "DOM ID lookup"),
                                ("dom-query", "bulk: total ms", "Bulk DOM query"),
                                ("dom-traversal", "build", "Tree construction"),
                                ("dom-traversal", "traverse (total)", "Tree traversal")]:
        for lang, guest in languages.items():
            series = [durations[demo, f"{lang} {v}", metric] for v in ["direct", "baseline", "candidate", *previous]]
            if any(set(group) != control_rounds for group in series):
                raise ValueError(f"Incomplete DOM control samples for {demo} / {lang}")
            direct, baseline, candidate = [median(group.values()) for group in series[:3]]
            matched_plot[guest].append((title, baseline / direct, candidate / direct))
            if title == "Bulk DOM query":
                bulk_ratios.append(candidate / direct)
            wins = sum(series[2][n] <= series[1][n] for n in control_rounds)
            matched_rows.append([title, guest, *[f"{v * 1000:.2f}" for v in (direct, baseline, candidate)],
                                 f"{candidate / direct:.2f}×", f"{candidate / baseline:.2f}×",
                                 f"{wins}/{len(control_rounds)}"])
            if previous:
                prior = series[3]
                paired_wins = sum(series[2][n] <= prior[n] for n in control_rounds)
                matched_rows[-1].extend([f"{candidate / median(prior.values()):.2f}×", f"{paired_wins}/{len(control_rounds)}"])
    para(f"With list materialization on both sides, the candidate took **{min(bulk_ratios):.2f}–{max(bulk_ratios):.2f}×** "
         "the direct shim’s bulk-query time across the three guests. Times below are per measured workload, after warm-up.")
    fig, axes = plt.subplots(1, len(languages), figsize=(9.7, 3.2), layout="constrained", sharex=True, sharey=True)
    for ax, guest in zip(axes, languages.values()):
        phases, baseline, candidate = zip(*matched_plot[guest])
        positions = list(range(len(phases)))
        ax.axvline(1, color="#515151", linestyle="--", label="Direct shim")
        ax.hlines(positions, baseline, candidate, color="#b4bdc7", linewidth=2)
        ax.scatter(baseline, positions, color="#535d86", s=34, label="1.13.0", zorder=3)
        ax.scatter(candidate, positions, color="#067c77", s=32, marker="D", label="Candidate", zorder=3)
        ax.set_title(guest, fontsize=11)
        ax.grid(axis="x", alpha=.18)
        ax.set_yticks(positions, phases)
    slowest = max(max(baseline, candidate) for group in matched_plot.values() for _, baseline, candidate in group)
    axes[0].set_xlim(0, max(1, slowest) * 1.08)
    axes[0].invert_yaxis()
    fig.supxlabel("Median time / direct shim (lower is faster)", fontsize=10)
    fig.legend(*axes[-1].get_legend_handles_labels(), loc="outside upper center", ncols=3, fontsize=9)
    fig.savefig(results / "dom-control-runtime.png", dpi=155)
    plt.close(fig)
    para("![DOM phase times for Jco 1.13.0 and the candidate relative to the same-guest direct shim]"
         "(web/bench/results/dom-control-runtime.png)")
    table(["Phase", "Guest", "Direct (ms)", "1.13.0 (ms)", "Candidate (ms)", "Candidate / direct",
           "Candidate / 1.13.0", "Rounds at or below 1.13.0",
           *(["Candidate / previous", "Rounds at or below previous"] if previous else [])], matched_rows)
    startup_rows = []
    for demo, title in (("dom-query", "ID and bulk query"), ("dom-traversal", "Tree traversal")):
        for lang, guest in languages.items():
            groups = [control_loads[demo, f"{lang} {v}"] for v in ("direct", "baseline", "candidate")]
            if any(set(group) != control_rounds for group in groups):
                raise ValueError(f"Incomplete DOM startup samples for {demo} / {lang}")
            direct, baseline, candidate = [median(group.values()) for group in groups]
            startup_rows.append([title, guest, *[f"{v:.2f}" for v in (direct, baseline, candidate)],
                                 f"{candidate / direct:.2f}×", f"{candidate / baseline:.2f}×"])
    para(f"On the same guest binaries, initialization took the following times before the first guest call. "
         f"Each median covers {len(control_rounds)} fresh pages and includes importing the binding module, fetching "
         "the guest and instantiating it. The direct shim uses `WebAssembly.instantiateStreaming`.")
    table(["Workload", "Guest", "Direct startup (ms)", "1.13.0 (ms)", "Candidate (ms)", "Candidate / direct",
           "Candidate / 1.13.0"], startup_rows)
loop = json.loads((results / "import-loop.json").read_text())
if any(loop[key] != sizes[key] for key in ("candidate", "main", "baseline")):
    raise ValueError("Import loop and demo measurements use different builds")
for key, filename in [("runnerSha256", "import-loop.mjs"), ("fixtureSha256", "import-loop.wat")]:
    if sha256((bench / filename).read_bytes()).hexdigest() != loop[key]:
        raise ValueError("Import loop source changed: " + filename)
loop_rounds = range(1, loop["rounds"] + 1)
loop_passes = set(range(1, loop["repeats"] + 1))
loop_times = defaultdict(dict)
transfer_counts = {"pixels": loop["pixelCopies"], "pixelWrites": loop["pixelCopies"],
                   "asciiResult": loop["textCopies"], "unicodeResult": loop["textCopies"],
                   "shortAsciiResult": loop["shortTextCopies"], "shortUnicodeResult": loop["shortTextCopies"]}
for sample in loop["samples"]:
    group = loop_times[sample["op"], sample.get("length"), sample["name"], sample["round"]]
    expected_count = transfer_counts.get(sample["op"], loop["iterations"])
    if sample["pass"] in group or sample["elapsedMs"] <= 0 or sample["count"] != expected_count:
        raise ValueError("Duplicate or invalid import loop sample")
    group[sample["pass"]] = sample["elapsedMs"] * 1e6 / sample["count"]
loop_rows = []
loop_ratios = []
for op, length, label in [("numbers", None, "u32"), ("strings", 2, "2-byte string"), ("strings", 9, "9-byte string"),
                          ("strings", 32, "32-byte string"), ("resources", None, "Acquire, borrow, drop"),
                          ("options", None, "Optional resource, half present"),
                          ("pixels", None, "121 KiB host-to-guest byte list"),
                          ("pixelWrites", None, "121 KiB guest-to-host byte list"),
                          ("shortAsciiResult", None, "16-byte UTF-8 result, repeated ASCII"),
                          ("shortUnicodeResult", None, "16-byte UTF-8 result, rotating Unicode"),
                          ("asciiResult", None, "16 KiB UTF-8 result, repeated ASCII"),
                          ("unicodeResult", None, "16 KiB UTF-8 result, rotating Unicode")]:
    medians = []
    for version in ("direct", "baseline", "main", "candidate"):
        groups = [loop_times[op, length, version, n] for n in loop_rounds]
        if any(set(group) != loop_passes for group in groups):
            raise ValueError("Missing import loop sample")
        medians.append(median(median(group.values()) for group in groups))
    direct, baseline, main, candidate = medians
    loop_ratios.append((label, direct / baseline, main / baseline, candidate / baseline))
    loop_rows.append([label, *[f"{v:,.1f}" for v in medians],
                      f"{candidate / baseline:.2f}×", f"{candidate / direct:.2f}×"])
para("### Cost of a synchronous host import")
para(f"The scalar, string and resource loops run {loop['iterations']:,} iterations per pass. The string loop changes the first byte "
     "before each call. The resource loop acquires a host object, borrows it to read its value, and drops it. "
     "The optional-resource loop checks the discriminant in guest memory every time and reads and drops each present handle. "
     "Each pass checks its checksum. All four adapters use byte-identical core modules. The direct shim "
     "keeps the fixture’s single live handle in one slot.")
para(f"The byte-list loops copy a 176 × 176 RGBA region ({176 * 176 * 4:,} bytes) "
     f"{loop['pixelCopies']:,} times per pass in each direction. The host-to-guest case uses a reusable host view "
     "and a fixed guest allocation. In the reverse direction the host keeps the final snapshot while the guest "
     "changes the source in Wasm. Both cases sum the changing first byte during the loop and verify the whole "
     "payload afterward. The canvas demo also measures browser readback, host allocation and guest allocation.")
para(f"The string-return loops make {loop['shortTextCopies']:,} calls per pass for 16-byte results and "
     f"{loop['textCopies']:,} for 16 KiB results. "
     "One host returns a repeated ASCII string. The other rotates four strings containing two-, three-, and four-byte "
     "UTF-8 sequences. The guest checks each byte length, sums the first bytes, and hashes every distinct result outside the timer.")
para(f"Times are nanoseconds per guest iteration, including the loop and host work. Each cell is the median "
     f"of {loop['rounds']} fresh-page medians, with {loop['warmups']} warm-ups and {loop['repeats']} timed passes "
     f"per page. The runner interleaves the four builds. [Raw timings and digests](web/bench/results/import-loop.json)")
table(["Operation", "Direct", "1.13.0", "Stock main", "Candidate", "Candidate / 1.13.0", "Candidate / direct"], loop_rows)

fig, ax = plt.subplots(figsize=(9.5, 5.5), layout="constrained")
for column, name, color, marker in [(1, "Direct shim", "#69717b", "o"), (2, "Stock main", "#c46320", "s"),
                                     (3, "Candidate", "#067c77", "D")]:
    ax.scatter([row[column] for row in loop_ratios], [i + (column - 2) * .18 for i in range(len(loop_ratios))],
               label=name, color=color, marker=marker, s=30)
ax.set_xscale("log", base=2)
ax.axvline(1, linestyle="--", color="#515151", linewidth=1, label="1.13.0")
left, right = ax.get_xlim()
ticks = [2.0 ** power for power in range(-10, 11) if left <= 2.0 ** power <= right]
ax.set_xticks(ticks, [f"{tick:g}×" for tick in ticks])
ax.set_yticks(range(len(loop_ratios)), [row[0] for row in loop_ratios])
ax.invert_yaxis()
ax.grid(axis="x", alpha=.2)
ax.set_axisbelow(True)
ax.set_xlabel("Median time per guest iteration / 1.13.0 (lower is faster)")
ax.legend(loc="upper center", bbox_to_anchor=(.5, -.13), ncol=4, fontsize=9)
fig.savefig(results / "import-loop-runtime.png", dpi=155)
plt.close(fig)
para("![Time per guest iteration relative to Jco 1.13.0, by import and transfer direction](web/bench/results/import-loop-runtime.png)")

canvas = json.loads((results / "canvas-control-browser.json").read_text())
if canvas["sizesSha256"] != run["sizesSha256"] or canvas["candidate"] != run["candidate"]:
    raise ValueError("The canvas observer used different generated bindings")
for path, digest in canvas["sources"].items():
    if sha256((bench.parent / path).read_bytes()).hexdigest() != digest:
        raise ValueError(f"Canvas observer source has changed: {path}")
readbacks = {}
for sample in canvas["samples"]:
    key = sample["implementation"], sample["round"], sample["pass"]
    data = sample["canvas"]
    if (key in readbacks or sample["demo"] != "canvas-pixels" or data["bytes"] != 176**2 * 4 or
            not (0 <= data["hostUs"] <= data["totalUs"]) or
            abs(data["totalUs"] - data["hostUs"] - data["remainderUs"]) > 1e-6 or
            data["reps"] < 1 or data["reps"] & (data["reps"] - 1)):
        raise ValueError(f"Invalid canvas observation for {key}")
    readbacks[key] = data
pages = range(1, canvas["rounds"] + 1)
passes = range(1, canvas["passes"] + 1)
canvas_rows = []
canvas_host_share = []
canvas_remainders = defaultdict(list)
for lang, guest in languages.items():
    for version, name in [("baseline", "1.13.0"), ("candidate", "Candidate")]:
        page_samples = [[readbacks[f"{lang} {version}", n, p] for p in passes] for n in pages]
        cells = [median(median(row[field] for row in page) for page in page_samples)
                 for field in ("totalUs", "hostUs", "remainderUs")]
        percent = median(median(100 * row["hostUs"] / row["totalUs"] for row in page) for page in page_samples)
        canvas_host_share.append(percent)
        canvas_remainders[version].append(cells[2])
        canvas_rows.append([guest, name, *[f"{value:,.1f}" for value in cells], f"{percent:.1f}%"])
if len(readbacks) != len(canvas_rows) * len(pages) * len(passes):
    raise ValueError("Unexpected number of canvas observations")
para("### Where the canvas read spends its time")
para("The same-page comparison was repeated with a clock around the demo’s host method. "
     "That method reads 176 × 176 pixels from Chromium and creates a JavaScript byte array. "
     "The remainder includes guest allocation and freeing, the copy into Wasm, binding checks, the loop and observer overhead. "
     f"Each cell is a median across {len(pages)} page medians. Columns are summarized independently. "
     "[Raw instrumented samples](web/bench/results/canvas-control-browser.json)")
table(["Guest", "Bindings", "Full read (µs)", "Inside host (µs)", "Remainder (µs)", "Inside host (%)"], canvas_rows)
para(f"The host accounted for {min(canvas_host_share):.1f}–{max(canvas_host_share):.1f}% of the full read across these builds. "
     f"The candidate spent {min(canvas_remainders['candidate']):.1f}–{max(canvas_remainders['candidate']):.1f} µs per read outside the host, "
     f"compared with {min(canvas_remainders['baseline']):.1f}–{max(canvas_remainders['baseline']):.1f} µs for 1.13.0.")

host_run = json.loads((results / "canvas-host.json").read_text())
if any(host_run[key] != run[key] for key in ("candidate", "cpu", "browser", "sizesSha256")):
    raise ValueError("Canvas host comparison used different builds or hardware")
for path, digest in {**host_run["sources"], "bench/canvas-host-bench.mjs": host_run["runnerSha256"]}.items():
    if sha256((bench.parent / path).read_bytes()).hexdigest() != digest:
        raise ValueError(f"Canvas host source has changed: {path}")
host_rounds = range(1, host_run["rounds"] + 1)
host_passes = range(1, host_run["passes"] + 1)
build_names = {"direct": "Direct shim", "baseline": "1.13.0", "main": "Stock main", "candidate": "Candidate"}
host_names = ("original", "view")
canvas_times = {}
for row in host_run["samples"]:
    key = tuple(row[field] for field in ("lang", "host", "version", "round", "pass"))
    values = (row["readUs"], row["writeUs"])
    if (key in canvas_times or row["pixelsChecked"] != 2 * host_run["size"]**2
            or not all(isfinite(v) and v > 0 for v in values)):
        raise ValueError(f"Invalid canvas host sample for {key}")
    canvas_times[key] = values
if len(canvas_times) != len(languages) * len(host_names) * len(build_names) * len(host_rounds) * len(host_passes):
    raise ValueError("Unexpected number of canvas host samples")

host_medians, host_rows = {}, []
for lang, guest in languages.items():
    for version, label in build_names.items():
        cells = []
        for phase in range(2):
            for host in host_names:
                value = median(median(canvas_times[lang, host, version, n, p][phase] for p in host_passes)
                               for n in host_rounds)
                host_medians[lang, host, version, phase] = value
                cells.append(f"{value:.1f}")
        host_rows.append([guest, label, *cells])

para("### Canvas pixel transfers with the same guest binary")
region_size = host_run["size"] - 80
para(f"Each call transfers a {region_size} × {region_size} RGBA region ({region_size**2 * 4:,} bytes). "
     "The original browser host copies the pixel array on both read and write. The alternate host creates a "
     "typed-array view over the browser’s readback or the binding’s write snapshot, preserving its offset and length. "
     "All four implementations still copy the bytes across the Wasm boundary. "
     "[View adapter](web/bench/canvas-host.mjs) · [Direct shim](web/bench/dom-core-shim.mjs)")
para(f"For each guest, all four bindings use identical core Wasm. Each table cell is the median of "
     f"{len(host_rounds)} page medians, with one warm-up and {len(host_passes)} measured passes per page. "
     "The runner rotates the four bindings on each page, alternates the host order and checks every pixel on "
     f"both canvases after each invocation. [Raw timings and pixel checks](web/bench/results/canvas-host.json)")
direct_ratios, savings = [], defaultdict(list)
for lang in languages:
    for phase in range(2):
        view = host_medians[lang, "view", "candidate", phase]
        direct_ratios.append(view / host_medians[lang, "view", "direct", phase])
        savings[phase].append(100 * (1 - view / host_medians[lang, "original", "candidate", phase]))
para(f"Changing the host reduced the candidate’s read time by **{min(savings[0]):.0f}–{max(savings[0]):.0f}%** "
     f"and write time by **{min(savings[1]):.0f}–{max(savings[1]):.0f}%**. With the view adapter, its six "
     f"timings were **{min(direct_ratios):.2f}–{max(direct_ratios):.2f}×** the corresponding direct shim times. "
     "The headline benchmarks use the original host.")
fig, axes = plt.subplots(1, 2, figsize=(9, 3.25), layout="constrained")
for phase, ax in enumerate(axes):
    for offset, (host, version, label, color) in enumerate([
        ("original", "candidate", "Candidate, original host", "#535d86"),
        ("view", "candidate", "Candidate, view host", "#067c77"),
        ("view", "direct", "Direct shim, view host", "#d08b38"),
    ]):
        ax.barh([i + (offset - 1) * .24 for i in range(len(languages))],
                [host_medians[lang, host, version, phase] for lang in languages],
                height=.22, label=label, color=color)
    ax.set_yticks(range(len(languages)), languages.values())
    ax.invert_yaxis()
    ax.set_title(["Canvas read", "Canvas write"][phase], fontsize=11)
    ax.grid(axis="x", alpha=.2)
fig.supxlabel("Microseconds per call (lower is faster)", fontsize=10)
fig.legend(*axes[0].get_legend_handles_labels(), loc="outside upper center", ncols=3, fontsize=9)
fig.savefig(results / "canvas-host-runtime.png", dpi=155)
plt.close(fig)
para("![Canvas read and write times for the candidate with both hosts and the direct shim with pixel views]"
     "(web/bench/results/canvas-host-runtime.png)")
table(["Guest", "Bindings", "Original read (µs)", "View read (µs)", "Original write (µs)", "View write (µs)"], host_rows)

para("<details><summary>All timed phases and string lengths</summary>")
table(["Demo", "Phase", "Guest", "Candidate time", "Fresh-page / 1.13.0", "Same-page / 1.13.0", "Candidate / main", "Fastest shim", "Candidate / shim"], phase_rows)
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
minified_run, distribution = distributions(bench, sizes, run, focus, languages)
para("### What ships with `--minify`")
para(f"Each Jco build generated its default and minified distribution from the same {len(paired)} components. "
     "Jco 1.13.0 uses Terser for its minify option. Stock main and the branch use Oxc. All external Wasm files "
     "matched byte for byte across formats. Payloads include JavaScript and external Wasm, compressed per file. "
     f"Chromium interleaved the six distributions across {len(minified_run['samples']):,} fresh pages, "
     f"with {minified_run['rounds']} rounds for each of the 21 guest and workload combinations. "
     "The two ratio columns compare each format to that build’s default for the same guest and workload, then take "
     "the median of the 21 ratios. The final column compares workload times to the same format of 1.13.0. "
     "[Distribution sizes](web/bench/results/minified-sizes.json) · [Timings and resource requests](web/bench/results/minified-browser.json)")
distribution_names = {"baseline": "1.13.0", "main": "Stock main", "candidate": "Candidate"}
distribution_rows, stage_rows = [], []
for version, values in distribution.items():
    base, _, mode = version.partition("-")
    label = distribution_names[base] + (" minified" if mode else " default")
    distribution_rows.append([label, *[f"{v:.1f}" for v in values["payload"]], f"{values['startup']:.2f}",
                              f"{values['load_ratio']:.2f}×", f"{values['runtime_ratio']:.2f}×", f"{values['wins']}/21"])
    stage_rows.append([label, *[f"{v:.2f}" for v in values["stages"]]])
table(["Distribution", "JS (KiB)", "Total gzip (KiB)", "Total Brotli (KiB)", "Startup (ms)",
       "Startup / default", "Runtime / default", "At or below 1.13.0"], distribution_rows)
para("Chromium’s Resource Timing entries give four consecutive intervals from the start of dynamic import until "
     "the module is ready. The gap before the first Wasm request includes resolving dependencies and executing "
     "JavaScript. The local server served uncompressed assets with caching disabled. Browser response-body sizes "
     "were checked against the generated file sizes. Each column reports its own median over workload medians.")
table(["Distribution", "Import to JS response end (ms)", "JS response end to first Wasm request (ms)",
       "First Wasm request to last Wasm response (ms)", "Last Wasm response to ready (ms)"], stage_rows)
branch_min = distribution["candidate-minified"]
release_min = distribution["baseline-minified"]
para(f"Minifying the branch reduced startup by {100 * (1 - branch_min['load_ratio']):.0f}% on the median "
     f"same-workload comparison. Its median import-to-ready time was {branch_min['startup']:.2f} ms, "
     f"compared with {release_min['startup']:.2f} ms for minified 1.13.0. "
     f"Between the end of the entry JavaScript response and the first Wasm request, "
     f"the corresponding medians were {branch_min['stages'][1]:.2f} and {release_min['stages'][1]:.2f} ms.")
fig, (payload_ax, load_ax) = plt.subplots(1, 2, figsize=(9, 3.25), layout="constrained")
for ax, metric, label in [(payload_ax, "gzip", "Total gzip (KiB)"), (load_ax, "startup", "Import to ready (ms)")]:
    for offset, mode, color in [(-.18, "", "#687581"), (.18, "-minified", "#067c77")]:
        groups = [distribution[base + mode] for base in distribution_names]
        data = [v["payload"][1] if metric == "gzip" else v["startup"] for v in groups]
        ax.barh([i + offset for i in range(len(data))], data, height=.31, color=color,
                label="Minified" if mode else "Default")
    ax.set_yticks(range(len(distribution_names)), distribution_names.values())
    ax.invert_yaxis()
    ax.set_xlabel(label)
    ax.grid(axis="x", alpha=.2)
    ax.set_axisbelow(True)
payload_ax.legend(loc="upper center", bbox_to_anchor=(1, -.22), ncol=2, frameon=False)
fig.savefig(results / "minified-startup.png", dpi=155)
plt.close(fig)
para("![Default and minified gzip payloads and fresh-page startup for three Jco builds](web/bench/results/minified-startup.png)")

observer_path = results / "startup-observer.json"
observer = json.loads(observer_path.read_bytes())
if (observer["originalSha256"] != sha256((results / "minified-browser.json").read_bytes()).hexdigest()
        or observer["runnerSha256"] != sha256((bench / "startup-observer.mjs").read_bytes()).hexdigest()
        or any(observer[key] != minified_run[key] for key in ("browser", "cpu"))):
    raise ValueError("Startup observer did not use the measured browser and bindings")
observer_groups = defaultdict(dict)
for row in observer["samples"]:
    key = row["version"], row["attached"], row["lang"], row["demo"]
    if (row["round"] in observer_groups[key]
            or not 0 <= row["jsEndMs"] <= row["wasmStartMs"] <= row["wasmEndMs"] <= row["loadMs"] + .01):
        raise ValueError(f"Invalid startup observer record for {key}")
    observer_groups[key][row["round"]] = (row["loadMs"], row["wasmStartMs"] - row["jsEndMs"])
cases = [(lang, demo) for lang in languages for demo in focus]
expected = {(version, attached, *case) for version in distribution for attached in (True, False) for case in cases}
if (set(observer_groups) != expected or
        any(set(rows) != set(range(1, observer["rounds"] + 1)) for rows in observer_groups.values())):
    raise ValueError("Missing startup observer trials")
para("### Startup with DevTools disconnected")
para(f"In {len(observer['samples']):,} fresh documents, the page timed its own dynamic import, ran the guest "
     "and sent the result to a local server. One browser kept the Puppeteer DevTools connection open. "
     "The other disconnected before the first measured navigation. Both navigated the same tab, with matching "
     "Chrome flags, no-store responses and verified network transfers. The order of the two browsers alternated "
     f"over {observer['rounds']} rounds. Each table cell is the median of the 21 workload medians. "
     "[Observer timings](web/bench/results/startup-observer.json)")
observer_rows = []
for version in distribution:
    base, _, mode = version.partition("-")
    label = distribution_names[base] + (" minified" if mode else " default")
    columns = [median(median(row[column] for row in observer_groups[version, attached, *case].values())
                      for case in cases) for column in (0, 1) for attached in (True, False)]
    observer_rows.append([label, *[f"{value:.2f}" for value in columns]])
table(["Distribution", "Attached startup (ms)", "Detached startup (ms)", "Attached JS end to Wasm request (ms)",
       "Detached JS end to Wasm request (ms)"], observer_rows)

coverage = json.loads((results / "js-coverage.json").read_text())
if (coverage["sizesSha256"] != run["sizesSha256"] or coverage["workloads"] != run["workloads"] or
        coverage["runnerSha256"] != sha256((bench / "coverage.mjs").read_bytes()).hexdigest()):
    raise ValueError("JavaScript coverage and measured builds differ")
for path, digest in coverage["sources"].items():
    if sha256((bench.parent / path).read_bytes()).hexdigest() != digest:
        raise ValueError(f"Coverage source changed: {path}")
entries = {asset["path"]: asset for component in sizes["components"]
           for files in component["variants"].values() for asset in files}
used = {}
for sample in coverage["samples"]:
    key = (sample["demo"], sample["lang"], sample["version"], sample["phase"])
    asset = entries[sample["path"]]
    if (key in used or sample["sha256"] != asset["sha256"] or sample["bytes"] != asset["bytes"] or
            not 0 < sample["used"] <= sample["bytes"]):
        raise ValueError(f"Invalid JS coverage for {key}")
    used[key] = sample
coverage_rows = []
for version, name in [("baseline", "1.13.0"), ("main", "Stock main"), ("candidate", "Candidate")]:
    groups = [[used[demo, lang, version, phase] for demo in focus for lang in languages] for phase in ("init", "firstRun")]
    coverage_rows.append([name, *[f"{median(r['used'] for r in group) / 1024:.1f}" for group in groups],
                          f"{median(100 * r['used'] / r['bytes'] for r in groups[1]):.1f}%",
                          f"{median(r['bytes'] - r['used'] for r in groups[1]) / 1024:.1f}"])
if len(used) != 2 * len(languages) * len(focus) * len(coverage_rows):
    raise ValueError("Unexpected JavaScript coverage sample count")
para("### Generated JavaScript reached by each demo")
para(f"Chromium recorded block coverage on {len(used)} fresh pages in a separate run. One page imported each "
     "module and finished initialization. A second also ran the demo once and checked its output. The table reports "
     "medians over the 21 guest and workload combinations. Sizes count UTF-8 bytes in V8’s covered source ranges. "
     "A demo can leave error handling, shutdown or other supported operations unexercised. "
     "[Per-module coverage and hashes](web/bench/results/js-coverage.json)")
table(["Build", "Reached at init (KiB)", "Reached through first run (KiB)", "Share through first run",
       "Unreached through first run (KiB)"], coverage_rows)

para("<details><summary>Candidate startup, variation and paired comparison to 1.13.0</summary>")
para("The paired ratio divides the candidate time by the 1.13.0 time within each round, then takes the median. "
     "The final column counts rounds where the candidate was at least as fast.")
table(["Operation", "Guest", "Startup median (ms)", "Warm phase p25", "Warm phase p50", "Warm phase p75", "Phase unit", "Paired ratio to 1.13.0", "Rounds at or below 1.13.0"], [
    [label, title, f"{median(loads[demo, f'{lang} candidate'].values()):.2f}",
     *[f"{v * (1000 if unit == 'ms' else 1_000_000):,.2f}" for v in
       [quantile(times[demo, f"{lang} candidate", metric].values(), q) for q in (.25, .5, .75)]], unit,
     f"{median(times[demo, f'{lang} candidate', metric][n] / times[demo, f'{lang} baseline', metric][n] for n in rounds):.2f}×",
     f"{sum(times[demo, f'{lang} candidate', metric][n] <= times[demo, f'{lang} baseline', metric][n] for n in rounds)}/{len(rounds)}"]
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
CHROME_BIN=/path/to/chrome BENCH_DOM_CONTROL=1 ROUNDS={control["rounds"] if control_path.exists() else 9} node web/bench/browser.mjs
CHROME_BIN=/path/to/chrome BENCH_PAIRED=1 ROUNDS={paired_run["rounds"]} node web/bench/browser.mjs
CHROME_BIN=/path/to/chrome BENCH_CANVAS_CONTROL=1 ROUNDS={canvas["rounds"]} node web/bench/browser.mjs
CHROME_BIN=/path/to/chrome ROUNDS={host_run["rounds"]} node web/bench/canvas-host-bench.mjs
CHROME_BIN=/path/to/chrome ROUNDS={loop["rounds"]} node web/bench/import-loop.mjs ../jco-candidate
CHROME_BIN=/path/to/chrome node web/bench/coverage.mjs
pnpm -C ../jco-candidate install --frozen-lockfile
pnpm -C ../jco-candidate --filter @bytecodealliance/jco-transpile run build
node web/bench/candidate.mjs --verify-wasm ../jco-candidate
node web/bench/minified.mjs ../jco-candidate
CHROME_BIN=/path/to/chrome BENCH_MINIFIED=1 ROUNDS={minified_run['rounds']} node web/bench/browser.mjs
CHROME_BIN=/path/to/chrome ROUNDS={observer['rounds']} node web/bench/startup-observer.mjs
python3 web/bench/report.py --from-candidate
python3 web/bench/candidate-report.py
```""")
para("The minification comparison uses each version’s packaged transpiler. The verification command compares "
     "the packaged candidate’s default JavaScript and core Wasm to the native generator’s measured output for every input.")
readme = bench.parents[1] / "README.md"
text = readme.read_text()
a, b = "<!-- candidate:start -->", "<!-- candidate:end -->"
if a not in text:
    text = text.replace("<!-- benchmark:start -->", a + "\n" + b + "\n\n<!-- benchmark:start -->", 1)
readme.write_text(text[:text.index(a)] + a + "\n\n" + "\n".join(lines) + "\n" + text[text.index(b):])
