"""Measure cold native bindgen processes on the same guest and verify every emitted asset."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import random
import resource
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("reference", type=Path, help="Previous native transpile executable")
parser.add_argument("candidate", type=Path, help="Current native transpile executable")
parser.add_argument("--build-profile", default="unspecified", help="Cargo profile used for both executables")
parser.add_argument("--rounds", type=int, default=21)
args = parser.parse_args()
if args.rounds < 1:
    parser.error("--rounds must be positive")
bench = Path(__file__).resolve().parent
web = bench.parent
inventory = (bench / "results/candidate-sizes.json").read_bytes()
sizes = json.loads(inventory)
inputs = ["c/dom-query/native/dom_query.wasm", "rust/canvas-draw/native/canvas_draw.wasm",
          "cpp/table-update/native/table_update.wasm"]
components = {c["input"]["path"]: c for c in sizes["components"]}
binaries = {v: getattr(args, v).resolve() for v in ("reference", "candidate")}
if binaries["reference"].samefile(binaries["candidate"]):
    parser.error("The two executables must be distinct")
mappings = ["--map=" + module + "=../../../host/web-host.js#" + export
            for module, export in (line.split() for line in (web / "host/imports.txt").read_text().splitlines() if line)]
def sha256(data):
    return hashlib.sha256(data).hexdigest()

for path in inputs:
    assert sha256((web / path).read_bytes()) == components[path]["input"]["sha256"]
seed = 31801
rng = random.Random(seed)
samples = []
with tempfile.TemporaryDirectory(prefix="jco-native-timing-") as tmp:
    for n in range(args.rounds + 1):
        for path in rng.sample(inputs, len(inputs)):
            for version in rng.sample(list(binaries), len(binaries)):
                # A distinct destination prevents a partial write from reusing the previous build's output.
                out = Path(tmp) / str(n) / version / Path(path).stem
                out.mkdir(parents=True)
                command = [str(binaries[version]), str(web / path), str(out), "--name=" + Path(path).stem,
                           "--no-nodejs-compat", "--base64-cutoff=5000", "--namespaced-exports", *mappings]
                usage = resource.getrusage(resource.RUSAGE_CHILDREN)
                start = time.monotonic_ns()
                subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
                wall_ms = (time.monotonic_ns() - start) / 1e6
                end = resource.getrusage(resource.RUSAGE_CHILDREN)
                cpu_ms = 1000 * ((end.ru_utime - usage.ru_utime) + (end.ru_stime - usage.ru_stime))
                expected = {Path(f["path"]).name: f["sha256"] for f in components[path]["variants"][version]}
                actual = {f.name: sha256(f.read_bytes()) for f in out.iterdir() if f.suffix in (".js", ".wasm")}
                if actual != expected:
                    raise ValueError(f"Unexpected emitted files for {version} {path}")
                if n:
                    samples.append({"round": n, "version": version, "input": path, "wallMs": wall_ms, "cpuMs": cpu_ms})
                for f in out.iterdir():
                    f.unlink()
cpu = platform.processor()
if Path("/proc/cpuinfo").is_file():
    cpu = next((line.partition(":")[2].strip() for line in Path("/proc/cpuinfo").read_text().splitlines()
                if line.startswith("model name")), cpu)
data = {"cpu": cpu, "buildProfile": args.build_profile,
        "rustc": subprocess.check_output(["rustc", "--version"], text=True).strip(), "rounds": args.rounds, "seed": seed, "machine": platform.uname().machine,
        "system": platform.system(), "release": platform.release(), "inputs": inputs,
        "inventorySha256": sha256(inventory), "runnerSha256": sha256(Path(__file__).read_bytes()),
        "versions": {v: {"commit": sizes[v]["commit"], "executableSha256": sha256(exe.read_bytes())}
                     for v, exe in binaries.items()}, "samples": samples}
(bench / "results/transpile-time.json").write_text(json.dumps(data, indent=2) + "\n")
print(f"Verified output for {len(samples)} timed native transpiler launches")
