"""Compare browser discovery and completion times within each paired round."""
import argparse
from collections import Counter
import gzip
from hashlib import sha256
import json
from pathlib import Path
from statistics import median

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("samples", type=Path)
parser.add_argument("matrix", type=Path)
args = parser.parse_args()
with gzip.open(args.samples) as stream:
    run = json.load(stream)
with gzip.open(args.matrix) as stream:
    matrix = json.load(stream)
assert run["runner"] == sha256(Path(__file__).with_name("task-import-order.mjs").read_bytes()).hexdigest()
assert run["matrix"] == sha256(args.matrix.read_bytes()).hexdigest()
assert run["browser"] == matrix["chromium"]
facade, children = run["facade"], run["children"]
assert run["original"] == matrix["manifest"][facade]["sha256"] != run["changed"]
assert sorted(p.split("/")[-1].split("-")[0] for p in children) == ["conversion", "core"]
assert run["network"] == dict(latency=40, download=1250000, upload=1250000)
reference = next(r for r in matrix["samples"] if r["version"] == "external" and r["lang"] == "c" and r["demo"] == "table-update")
paths = sorted(req["path"] for req in reference["requests"])
profiles = ["http1", "h2", "limited-h2"]
pages, positions, predecessors = {}, Counter(), Counter()
for rnd in range(18):
    group = sorted((s for s in run["samples"] if s["round"] == rnd), key=lambda s: s["position"])
    order = [(s["profile"], s["earlier"]) for s in group]
    assert set(order) == {(p, e) for p in profiles for e in [False, True]}
    assert [s["position"] for s in group] == list(range(6))
    positions.update(enumerate(order))
    predecessors.update(zip(order, order[1:]))
    for s in group:
        profile, earlier = s["profile"], s["earlier"]
        req = {r["path"]: r for r in s["requests"]}
        assert len(s["requests"]) == len(req) and sorted(req) == paths
        for path, r in req.items():
            assert r["protocol"] == ("http/1.1" if profile == "http1" else "h2")
            assert r["decoded"] == matrix["manifest"][path]["bytes"] + (run["rawBytesAdded"] if earlier and path == facade else 0)
            assert 0 <= r["start"] <= r["request"] <= r["firstByte"] <= r["end"] <= s["ready"]
        pages[rnd, profile, earlier] = {
            "last child discovered": max(req[path]["start"] for path in children),
            "last child request sent": max(req[path]["request"] for path in children),
            "last JS response end": max(r["end"] for path, r in req.items() if path.endswith(".js")),
            "guest Wasm request start": next(r["start"] for path, r in req.items() if path.endswith(".wasm")),
            "ready": s["ready"], "first result": s["firstResult"],
        }
assert len(pages) == len(run["samples"]) == 108
assert len(positions) == 36 and len(predecessors) == 30
assert set(positions.values()) == set(predecessors.values()) == {3}
print("Extra bytes, raw / Brotli:", run["rawBytesAdded"], run["brotliBytesAdded"])
for profile in profiles:
    print(profile)
    for key in pages[0, profile, False]:
        before = [pages[r, profile, False][key] for r in range(18)]
        after = [pages[r, profile, True][key] for r in range(18)]
        saved = sorted(b-a for a, b in zip(after, before))
        ratios = sorted(a/b for a, b in zip(after, before))
        print(f"{key}: {median(before):.2f} -> {median(after):.2f} ms;"
              f" paired ms saved {median(saved):.2f} ({saved[4]:.2f} to {saved[-5]:.2f});"
              f" ratio {median(ratios):.3f} ({ratios[4]:.3f}–{ratios[-5]:.3f})")
