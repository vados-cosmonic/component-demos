"""Summarize matched Jco distributions and Chromium Resource Timing entries."""
from collections import defaultdict
from hashlib import sha256
import json
from pathlib import Path
from statistics import median


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
