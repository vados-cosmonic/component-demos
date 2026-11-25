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
     "Resource drops use a one-argument trampoline that checks the instance flag and records traps. "
     "The internal Oxc bundle drops the general asynchronous import fallback for these components. "
     "The adapter holds direct references to its task stack and instance flags, checks the store for interruptions, "
     "and lifts short ASCII strings in groups of four bytes. "
     "Imported host resources with automatically assigned representations use their guest handle as an array index. "
     "Explicit host representations and shared tables use a representation map. "
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
         f"[Compare `{ref[:9]}` and `{commit[:9]}`](https://github.com/vados-cosmonic/jco/compare/{ref}...{commit})")
    comparisons = [(demo, metric, label) for demo, (metric, label, _) in focus.items()]
    comparisons += [("dom-query", "bulk: total ms", "Bulk DOM query"),
                    ("dom-traversal", "build", "Tree construction")]
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
paired_rows = []
paired_intervals = defaultdict(list)
paired_winners = 0
for demo, (metric, label, unit) in focus.items():
    for lang, title in languages.items():
        per_page = []
        for n in range(1, paired_run["rounds"] + 1):
            ratios = []
            for visit in range(1, paired_run["passes"] + 1):
                baseline, candidate = [paired_samples[demo, f"{lang} {v}", n, visit][metric]
                                       for v in ("baseline", "candidate")]
                ratios.append(candidate / baseline)
            per_page.append(median(ratios))
        midpoint = median(per_page)
        paired_winners += midpoint <= 1
        paired_intervals[title].append((midpoint, quantile(per_page, .25), quantile(per_page, .75)))
        paired_rows.append([label, title, f"{midpoint:.2f}×",
                            f"{quantile(per_page, .25):.2f}–{quantile(per_page, .75):.2f}×",
                            f"{sum(v <= 1 for v in per_page)}/{len(per_page)}"])
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
table(["Operation", "Guest", "Candidate / 1.13.0", "Middle 50% of page ratios", "Pages at or below 1×"], paired_rows)
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
    for sample in control["samples"]:
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
loop = json.loads((results / "import-loop.json").read_text())
if any(loop[key] != sizes[key] for key in ("candidate", "main", "baseline")):
    raise ValueError("Import loop and demo measurements use different builds")
for key, filename in [("runnerSha256", "import-loop.mjs"), ("fixtureSha256", "import-loop.wat")]:
    if sha256((bench / filename).read_bytes()).hexdigest() != loop[key]:
        raise ValueError("Import loop source changed: " + filename)
loop_rounds = range(1, loop["rounds"] + 1)
loop_passes = set(range(1, loop["repeats"] + 1))
loop_times = defaultdict(dict)
for sample in loop["samples"]:
    group = loop_times[sample["op"], sample.get("length"), sample["name"], sample["round"]]
    expected_count = loop["pixelCopies"] if sample["op"] == "pixels" else loop["iterations"]
    if sample["pass"] in group or sample["elapsedMs"] <= 0 or sample["count"] != expected_count:
        raise ValueError("Duplicate or invalid import loop sample")
    group[sample["pass"]] = sample["elapsedMs"] * 1e6 / sample["count"]
loop_rows = []
for op, length, label in [("numbers", None, "u32"), ("strings", 2, "2-byte string"), ("strings", 9, "9-byte string"),
                          ("strings", 32, "32-byte string"), ("resources", None, "Acquire, borrow, drop"),
                          ("options", None, "Optional resource, half present"),
                          ("pixels", None, "121 KiB host-to-guest byte list")]:
    medians = []
    for version in ("direct", "baseline", "main", "candidate"):
        groups = [loop_times[op, length, version, n] for n in loop_rounds]
        if any(set(group) != loop_passes for group in groups):
            raise ValueError("Missing import loop sample")
        medians.append(median(median(group.values()) for group in groups))
    direct, baseline, main, candidate = medians
    loop_rows.append([label, *[f"{v:,.1f}" for v in medians],
                      f"{candidate / baseline:.2f}×", f"{candidate / direct:.2f}×"])
para("### Cost of a synchronous host import")
para(f"The scalar, string and resource loops run {loop['iterations']:,} iterations per pass. The string loop changes the first byte "
     "before each call. The resource loop acquires a host object, borrows it to read its value, and drops it. "
     "The optional-resource loop checks the discriminant in guest memory every time and reads and drops each present handle. "
     "Each pass checks its checksum. All four adapters use byte-identical core modules. The direct shim "
     "keeps the fixture’s single live handle in one slot.")
para(f"The byte-list loop copies a 176 × 176 RGBA region ({176 * 176 * 4:,} bytes) "
     f"{loop['pixelCopies']:,} times per pass, using a reusable host view and a fixed guest allocation. "
     "It sums the changing first byte across transfers and verifies every byte of the final result after each pass. "
     "The canvas demo also measures browser readback, host allocation and guest allocation.")
para(f"Times are nanoseconds per guest iteration, including the loop and host work. Each cell is the median "
     f"of {loop['rounds']} fresh-page medians, with {loop['warmups']} warm-ups and {loop['repeats']} timed passes "
     f"per page. The runner interleaves the four builds. [Raw timings and digests](web/bench/results/import-loop.json)")
table(["Operation", "Direct", "1.13.0", "Stock main", "Candidate", "Candidate / 1.13.0", "Candidate / direct"], loop_rows)

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
CHROME_BIN=/path/to/chrome ROUNDS={loop["rounds"]} node web/bench/import-loop.mjs ../jco-candidate
python3 web/bench/candidate-report.py
```""")
readme = bench.parents[1] / "README.md"
text = readme.read_text()
a, b = "<!-- candidate:start -->", "<!-- candidate:end -->"
if a not in text:
    text = text.replace("<!-- benchmark:start -->", a + "\n" + b + "\n\n<!-- benchmark:start -->", 1)
readme.write_text(text[:text.index(a)] + a + "\n\n" + "\n".join(lines) + "\n" + text[text.index(b):])
