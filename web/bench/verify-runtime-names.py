"""Check the private-name change against a published component-demos revision."""
import json
import subprocess
from argparse import ArgumentParser
from hashlib import sha256
from pathlib import Path

bench = Path(__file__).resolve().parent
root = bench.parents[1]
results = bench / "results"
parser = ArgumentParser(description=__doc__)
parser.add_argument("previous", help="component-demos commit that measured the reference generator")
args = parser.parse_args()


def git(*args):
    return subprocess.check_output(["git", "-C", root, *args])


previous = git("rev-parse", "--verify", "--end-of-options", args.previous + "^{commit}").decode().strip()


def inventory(revision=None):
    def read(name):
        path = results / name
        return git("show", f"{revision}:{path.relative_to(root)}") if revision else path.read_bytes()

    default = read("candidate-sizes.json")
    minified = read("minified-sizes.json")
    sizes = json.loads(default)
    compact = json.loads(minified)
    hashes = {"default": sha256(default).hexdigest(), "minified": sha256(minified).hexdigest()}
    if compact["sizesSha256"] != hashes["default"]:
        raise ValueError("Minified inventory used a different generator or input set")
    return sizes, compact["components"], hashes


old, old_minified, old_hashes = inventory(previous)
new, new_minified, new_hashes = inventory()
if (old["candidate"]["commit"] != new["reference"]["commit"]
        or any(build["dirty"] for build in (old["candidate"], new["reference"], new["candidate"]))
        or set(old_minified) != set(new_minified)):
    raise ValueError("The previous benchmark must measure the current reference generator and inputs")
before = {c["input"]["path"]: c for c in old["components"]}
if set(before) != {c["input"]["path"] for c in new["components"]} or set(before) != set(old_minified):
    raise ValueError("Benchmark input sets differ")
diffs = []
for c in new["components"]:
    path = c["input"]["path"]
    if c["input"] != before[path]["input"]:
        raise ValueError(f"Guest changed: {path}")
    current = {Path(f["path"]).name: f for f in c["variants"]["candidate"]}
    reference = {Path(f["path"]).name: f for f in c["variants"]["reference"]}
    archived = {Path(f["path"]).name: f for f in before[path]["variants"]["candidate"]}
    if set(current) != set(reference) or set(reference) != set(archived):
        raise ValueError(f"Generated file list changed: {path}")
    occurrences = cores = 0
    for name, source in current.items():
        old_file = reference[name]
        data = (bench.parent / source["path"]).read_bytes()
        old_data = (bench.parent / old_file["path"]).read_bytes()
        if (sha256(data).hexdigest() != source["sha256"] or sha256(old_data).hexdigest() != old_file["sha256"]
                or old_file["sha256"] != archived[name]["sha256"]):
            raise ValueError(f"Generated asset differs from inventory: {path}, {name}")
        if name.endswith(".js"):
            occurrences += old_data.count(b"__jcoEmbeddedRuntime$")
            old_data = old_data.replace(b"__jcoEmbeddedRuntime$", b"$cm$")
        else:
            cores += 1
        if old_data != data:
            raise ValueError(f"Change beyond the private prefix: {path}, {name}")
    if occurrences == 0:
        raise ValueError(f"No private runtime names: {path}")
    # The packaged minifier can also change identifier assignments and formatting.
    # Compare the real minified artifacts recorded by each version.
    files_old, files_new = [i[path]["candidate-minified"] for i in (old_minified, new_minified)]
    for f in files_new:
        if sha256((bench.parent / f["path"]).read_bytes()).hexdigest() != f["sha256"]:
            raise ValueError(f"Current minified asset differs from inventory: {f['path']}")
    if {Path(f["path"]).name: f["sha256"] for f in files_old if f["path"].endswith(".wasm")} != {
        Path(f["path"]).name: f["sha256"] for f in files_new if f["path"].endswith(".wasm")
    }:
        raise ValueError(f"Minified core modules changed: {path}")
    diffs.append({"input": path, "occurrences": occurrences, "coreFiles": cores, "minifiedSavings": {
        k: sum(f[k] for f in files_old) - sum(f[k] for f in files_new) for k in ("bytes", "gzip", "brotli")
    }})
summary = {"previousBenchmark": previous, "reference": new["reference"]["commit"], "candidate": new["candidate"]["commit"],
           "previousHashes": old_hashes, "currentHashes": new_hashes, "inputs": diffs}
(results / "runtime-names.json").write_text(json.dumps(summary, indent=2) + "\n")
print(f"Verified private runtime names and core modules for {len(diffs)} inputs")
