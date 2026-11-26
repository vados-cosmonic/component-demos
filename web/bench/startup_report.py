"""Summarize matched Jco distributions and Chromium Resource Timing entries."""
from collections import defaultdict
from hashlib import sha256
import json
from math import isfinite
from pathlib import Path
from statistics import mean, median


def compile_hints(bench, run, observer, inventory, languages, versions):
    hint = b"//# allFunctionsCalledOnLoad\n"
    if (any(run[k] != observer[k] for k in ("runnerSha256", "originalSha256", "browser", "cpu"))
            or run["hint"].encode() != hint):
        raise ValueError("Compile hint trial used different source or hardware")
    cases = [(lang, demo) for lang in languages for demo in run["workloads"]]
    paths = set()
    for component in inventory["components"]:
        path = Path(component["input"]["path"])
        lang, demo = path.parts[:2]
        if (lang, demo) in cases and path.stem == demo.replace("-", "_"):
            for version in versions:
                paths.update("/" + f["path"] for f in component["variants"][version] if f["path"].endswith(".js"))
    if set(run["hintedSources"]) != paths:
        raise ValueError("Incomplete set of hinted JS modules")
    for path, digest in run["hintedSources"].items():
        local = bench.parent / path.lstrip("/")
        if len(bytes.fromhex(digest)) != 32 or (local.exists() and sha256(hint + local.read_bytes()).hexdigest() != digest):
            raise ValueError(f"Compile hint payload mismatch for {path}")
    groups = defaultdict(dict)
    fields = ("loadMs", "firstCallMs", "firstResultMs")
    for row in run["samples"]:
        key = row["version"], row["lang"], row["demo"]
        if (row["attached"] or row["round"] in groups[key]
                or not all(isfinite(row[m]) and row[m] > 0 for m in fields)
                or abs(row["loadMs"] + row["firstCallMs"] - row["firstResultMs"]) > .001):
            raise ValueError(f"Invalid compile hint record for {key}")
        groups[key][row["round"]] = row
    if run.get("reference") != inventory.get("reference"):
        raise ValueError("Startup comparison names a different reference generator")
    expected = {(v + suffix, *case) for v in versions for suffix in ("", "-eager") for case in cases}
    if run.get("reference"):
        expected.update(("reference", *case) for case in cases)
    if (set(groups) != expected
            or any(set(rows) != set(range(1, run["rounds"] + 1)) for rows in groups.values())):
        raise ValueError("Missing compile hint samples")
    summary = {}
    for version in versions:
        summary[version] = {}
        for case in cases:
            ordinary, eager = [groups[version + suffix, *case] for suffix in ("", "-eager")]
            summary[version][case] = [median(eager[n][field] / ordinary[n][field] for n in ordinary) for field in fields]
    absolute = {v: [median(median(row[m] for row in groups[v, *case].values()) for case in cases)
                    for m in fields] for v in ("candidate", "candidate-eager")}
    release_counts = {}
    for release in ("baseline", "baseline-eager"):
        comparisons = []
        for case in cases:
            candidate, baseline = groups["candidate-eager", *case], groups[release, *case]
            comparisons.append(median(candidate[n]["firstResultMs"] / baseline[n]["firstResultMs"] for n in candidate))
        release_counts[release] = sum(r <= 1 for r in comparisons)
    first_result_pairs = {}
    for case in cases:
        ordinary, eager = [groups[v, *case] for v in ("candidate", "candidate-eager")]
        first_result_pairs[case] = [eager[n]["firstResultMs"] / ordinary[n]["firstResultMs"] for n in ordinary]
    revision_pairs = {}
    if run.get("reference"):
        for case in cases:
            current, previous = [groups[v, *case] for v in ("candidate", "reference")]
            revision_pairs[case] = [[current[n][field] / previous[n][field] for n in current] for field in fields]
    return summary, absolute, release_counts, first_result_pairs, revision_pairs


def startup_intervals(sample, assets, expected_dir):
    requests = sample["requests"]
    for request in requests:
        path = request["path"]
        if (Path(path).parent != expected_dir or request["bytes"] != assets[path]
                or not 0 <= request["startMs"] <= request["endMs"] <= sample["loadMs"] + 0.01):
            raise ValueError(f"Unexpected response for {path}")
    scripts = [r for r in requests if r["path"].endswith(".js")]
    cores = [r for r in requests if r["path"].endswith(".wasm")]
    if len(scripts) != 1 or not cores or len(cores) + 1 != len(requests):
        raise ValueError(f"Expected a JS entry module followed by external Wasm for {expected_dir}")
    first_core = min(r["startMs"] for r in cores)
    last_core = max(r["endMs"] for r in cores)
    js_end = scripts[0]["endMs"]
    if first_core < js_end - 0.01:
        raise ValueError(f"Overlapping JS download and first Wasm fetch for {expected_dir}")
    return js_end, first_core - js_end, last_core - first_core, sample["loadMs"] - last_core


def distributions(bench, inventory, original, focus, languages):
    results = bench / "results"
    encoded = (results / "minified-sizes.json").read_bytes()
    extra = json.loads(encoded)
    run = json.loads((results / "minified-browser.json").read_bytes())
    if (run["minifiedSizesSha256"] != sha256(encoded).hexdigest()
            or extra["runnerSha256"] != sha256((bench / "minified.mjs").read_bytes()).hexdigest()
            or extra["sizesSha256"] != original["sizesSha256"]
            or any(run[key] != original[key] for key in ("sizesSha256", "sources", "workloads", "candidate", "browser", "cpu"))):
        raise ValueError("Minified and default builds, browser, or workloads differ")
    for path, digest in run["sources"].items():
        if sha256((bench.parent / path).read_bytes()).hexdigest() != digest:
            raise ValueError("Startup benchmark source changed: " + path)

    assets = {}
    totals = defaultdict(list)
    for component in inventory["components"]:
        path = component["input"]["path"]
        for version, files in (component["variants"] | extra["components"][path]).items():
            assets.update({asset["path"]: asset["bytes"] for asset in files})
            totals[version].append((sum(a["bytes"] for a in files if a["path"].endswith(".js")),
                                    sum(a["gzip"] for a in files), sum(a["brotli"] for a in files)))

    groups = defaultdict(dict)
    expected_rounds = set(range(1, run["rounds"] + 1))
    for sample in run["samples"]:
        lang, version = sample["implementation"].split()
        demo = sample["demo"]
        phase = focus[demo][0]
        stages = startup_intervals(sample, assets, Path(lang) / demo / ("jco-" + version))
        group = groups[demo, lang, version]
        if sample["round"] in group:
            raise ValueError(f"Repeated startup sample for {demo}/{lang}/{version}")
        group[sample["round"]] = (sample["loadMs"], sample["seconds"][phase], *stages)

    versions = ["baseline", "baseline-minified", "main", "main-minified", "candidate", "candidate-minified"]
    if set(groups) != {(demo, lang, ver) for demo in focus for lang in languages for ver in versions}:
        raise ValueError("Missing a guest, workload or Jco distribution")
    if any(set(samples) != expected_rounds for samples in groups.values()):
        raise ValueError("Missing startup measurement rounds")
    medians = {k: [median(column) for column in zip(*samples.values())] for k, samples in groups.items()}
    summary = {}
    for version in versions:
        base, _, mode = version.partition("-")
        baseline = "baseline-minified" if mode else "baseline"
        cases = [(demo, lang) for demo in focus for lang in languages]
        duration = [median(medians[demo, lang, version][column] for demo, lang in cases) for column in range(6)]
        summary[version] = {
            "payload": [median(column) / 1024 for column in zip(*totals[version])],
            "startup": duration[0], "stages": duration[2:],
            "load_ratio": median(medians[demo, lang, version][0] / medians[demo, lang, base][0] for demo, lang in cases),
            "runtime_ratio": median(medians[demo, lang, version][1] / medians[demo, lang, base][1] for demo, lang in cases),
            "wins": sum(medians[demo, lang, version][1] <= medians[demo, lang, baseline][1] for demo, lang in cases),
        }
    return run, summary


def wasm_api_timings(trial, observer, cases, versions):
    """Partition observed import time and compare each traced page with its ordinary control."""
    if any(trial[k] != observer[k] for k in ("runnerSha256", "originalSha256", "browser", "cpu")):
        raise ValueError("Wasm startup trial used different bindings, probe or browser")
    rounds = range(1, trial["rounds"] + 1)
    groups = defaultdict(dict)
    stages = ("js", "before", "compile", "instantiate", "both", "between", "after")
    operations = {"compile", "compileStreaming", "instantiate", "instantiateStreaming"}
    for row in trial["samples"]:
        group = groups[row["version"], row["lang"], row["demo"], row["traced"]]
        if row["attached"] or row["round"] in group or not isfinite(row["loadMs"]) or row["loadMs"] <= 0:
            raise ValueError("Invalid Wasm startup measurement")
        calls = row.get("wasmCalls")
        if bool(calls) != row["traced"]:
            raise ValueError("Missing Wasm calls or instrumented control")
        record = {"ready": row["loadMs"]}
        if calls:
            events = []
            for call in calls:
                kind = call["name"]
                start, end = call["startMs"], call["endMs"]
                if kind not in operations or not 0 <= start <= end <= row["loadMs"]:
                    raise ValueError("Wasm operation outside module import")
                activity = "compile" if kind.startswith("compile") else "instantiate"
                events.extend([(start, activity, 1), (end, activity, -1)])
            events.sort()
            first = events[0][0]
            if first < row["jsEndMs"] - .01 or {k for _, k, _ in events} != {"compile", "instantiate"}:
                raise ValueError("Unexpected Wasm operation sequence")
            running = {"compile": 0, "instantiate": 0}
            previous = first
            record.update(js=row["jsEndMs"], before=first - row["jsEndMs"], compile=0, instantiate=0, both=0,
                          between=0, after=row["loadMs"] - events[-1][0])
            for at, kind, change in events:
                if all(running.values()):
                    bucket = "both"
                elif running["compile"]:
                    bucket = "compile"
                elif running["instantiate"]:
                    bucket = "instantiate"
                else:
                    bucket = "between"
                record[bucket] += at - previous
                running[kind] += change
                previous = at
            if any(running.values()) or abs(sum(record[k] for k in stages) - row["loadMs"]) > .001:
                raise ValueError("Wasm intervals do not cover import")
        group[row["round"]] = record
    expected = {(v, lang, demo, traced) for v in versions for lang, demo in cases for traced in (True, False)}
    if set(groups) != expected or any(set(g) != set(rounds) for g in groups.values()):
        raise ValueError("Missing Wasm startup pages")

    summaries = {}
    for version in versions:
        per_case = defaultdict(list)
        for lang, demo in cases:
            measured, control = [groups[version, lang, demo, t] for t in (True, False)]
            for k in measured[1]:
                per_case[k].append(median(measured[n][k] for n in rounds))
            per_case["ratio"].append(median(measured[n]["ready"] / control[n]["ready"] for n in rounds))
        summaries[version] = {k: median(values) for k, values in per_case.items()}
    # Difference within each round before pooling workloads or languages.
    excess = defaultdict(list)
    for lang, demo in cases:
        candidate, baseline = [groups[v, lang, demo, True] for v in ("candidate", "baseline")]
        for k in candidate[1]:
            excess[k].append(median(candidate[n][k] - baseline[n][k] for n in rounds))
    # Fractions from one page sum to one; averaging them keeps the chart additive.
    shares = {}
    for v in versions:
        pages = [r for lang, demo in cases for r in groups[v, lang, demo, True].values()]
        shares[v] = {k: mean(100 * r[k] / r["ready"] for r in pages) for k in stages}
    return summaries, {k: median(values) for k, values in excess.items()}, shares


def module_body_timings(bench, trial, observer, inventory, languages, small_workloads):
    if (any(trial[k] != observer[k] for k in ("runnerSha256", "originalSha256", "browser", "cpu"))
            or trial["workloads"] != small_workloads):
        raise ValueError("Module body run used different workloads, source or hardware")
    versions = ["baseline", "main", "candidate"] + (["reference"] if inventory.get("reference") else [])
    cases = {(lang, demo) for lang in languages for demo in small_workloads}
    paths = set()
    directive = b'"use components";'
    marker = b'\nglobalThis.performance.mark("binding-module-body");\n'
    for component in inventory["components"]:
        path = Path(component["input"]["path"])
        lang, demo = path.parts[:2]
        if (lang, demo) not in cases or path.stem != demo.replace("-", "_"):
            continue
        for v in versions:
            asset, = [f for f in component["variants"][v] if f["path"].endswith(".js")]
            script = "/" + asset["path"]
            paths.add(script)
            local = bench.parent / asset["path"]
            if local.is_file():
                src = local.read_bytes()
                offset = len(directive) if src.startswith(directive) else 0
                if (sha256(src).hexdigest() != asset["sha256"] or
                        sha256(src[:offset] + marker + src[offset:]).hexdigest() != trial["markedSources"][script]):
                    raise ValueError("Unexpected module body source for " + script)
    if paths != set(trial["markedSources"]) or any(len(bytes.fromhex(h)) != 32 for h in trial["markedSources"].values()):
        raise ValueError("Incomplete module body source digests")
    rounds = set(range(1, trial["rounds"] + 1))
    pages = defaultdict(dict)
    for row in trial["samples"]:
        group = pages[row["version"], row["lang"], row["demo"], row["marked"]]
        first, ready = row["firstResultMs"], row["loadMs"]
        if (row["attached"] or row["round"] in group or not 0 < ready < first
                or abs(ready + row["firstCallMs"] - first) > .001):
            raise ValueError("Invalid module body page")
        record = {"ready": ready, "first": first}
        if row["marked"]:
            body, js, fetch = (row[k] for k in ("bodyStartMs", "jsEndMs", "wasmStartMs"))
            if not 0 <= js <= body + .01 or not body <= fetch + .01 or not fetch <= ready:
                raise ValueError("Invalid module body timestamp")
            record.update(before=body - js, after=fetch - body)
        elif "bodyStartMs" in row:
            raise ValueError("Found a marker on a control page")
        group[row["round"]] = record
    if (set(pages) != {(v, *case, m) for v in versions for case in cases for m in (True, False)}
            or any(set(group) != rounds for group in pages.values())):
        raise ValueError("Incomplete module body run")
    summaries = {}
    for v in versions:
        columns = defaultdict(list)
        for case in cases:
            marked, control = [pages[v, *case, m] for m in (True, False)]
            for key in ("before", "after"):
                columns[key].append(median(r[key] for r in marked.values()))
            for key in ("ready", "first"):
                columns[key].append(median(r[key] for r in control.values()))
            columns["overhead"].append(median(marked[n]["ready"] / control[n]["ready"] for n in rounds))
        summaries[v] = {k: median(values) for k, values in columns.items()}
    paired = {v: {case: [pages["candidate", *case, False][n]["first"] / pages[v, *case, False][n]["first"]
                         for n in sorted(rounds)] for case in cases} for v in versions if v != "candidate"}
    return summaries, paired
