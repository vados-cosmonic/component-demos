"""Compare the decoder import change across all demo inputs and three renderer modes."""
import argparse
import gzip
from hashlib import sha256
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

parser = argparse.ArgumentParser()
parser.add_argument("before", type=Path)
parser.add_argument("after", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
web = Path(__file__).resolve().parent.parent
inventory = json.loads((web / "bench/results/candidate-sizes.json").read_bytes())
maps = ["--map=" + name + "=../../../host/web-host.js#" + symbol for name, symbol in
        (line.split() for line in (web / "host/imports.txt").read_text().splitlines())]

def generate(binary, component, opts):
    with TemporaryDirectory(prefix="decoder-assets-") as directory:
        subprocess.run([binary.resolve(), component, directory, "--name=" + component.stem,
                        "--no-nodejs-compat", "--base64-cutoff=5000", "--namespaced-exports",
                        *opts, *maps], check=True)
        files = {p.name: p.read_bytes() for p in Path(directory).iterdir()}
    return files.pop(component.stem + ".js"), files

rows = []
for c in inventory["components"]:
    component = web / c["input"]["path"]
    assert sha256(component.read_bytes()).hexdigest() == c["input"]["sha256"]
    for mode, opts in [("bundled", []), ("external", ["--runtime=/runtime", "--cm-runtime-sync-imports"]),
                       ("v1", ["--runtime=/runtime"])]:
        before, old_files = generate(args.before, component, opts)
        after, new_files = generate(args.after, component, opts)
        assert old_files == new_files
        if mode == "v1":
            assert before == after
        if before != after:
            if mode == "bundled":
                # Oxc emits this local alias in the position of its supplying import.
                alias = b"const _decodeUtf8 = $cm$decodeUtf8;\n"
                assert before.count(alias) == after.count(alias) == 1
                assert before.replace(alias, b"") == after.replace(alias, b"")
            else:
                without_imports = lambda data: [line for line in data.splitlines(True) if not line.startswith(b"import ")]
                assert without_imports(before) == without_imports(after)
                assert b"decodeUtf8 as _decodeUtf8" in before and b"decodeSyncUtf8 as _decodeUtf8" in after
        rows.append({"path": c["input"]["path"], "mode": mode, "before": sha256(before).hexdigest(),
                     "after": sha256(after).hexdigest(), "bytesDelta": len(after) - len(before),
                     "gzipDelta": len(gzip.compress(after, mtime=0)) - len(gzip.compress(before, mtime=0))})
args.output.write_text(json.dumps({"before": sha256(args.before.read_bytes()).hexdigest(),
                                   "after": sha256(args.after.read_bytes()).hexdigest(), "rows": rows}, indent=2) + "\n")
