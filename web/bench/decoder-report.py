"""Verify decoder import graphs and summarize the matched fresh-document trials."""
from collections import Counter, defaultdict
import gzip
from hashlib import sha256
import json
from math import comb
from pathlib import Path
from statistics import median
import sys

bench = Path(__file__).resolve().parent
path = Path(sys.argv[1]) if len(sys.argv) > 1 else bench / "results/decoder-startup.json.gz"
with gzip.open(path) as f:
    run = json.load(f)
assert run["runnerSha256"] == sha256((bench / "decoder-startup.mjs").read_bytes()).hexdigest()
modes = ["release", "before", "after", "bundled"]
rows, order = defaultdict(dict), defaultdict(list)
for row in run["samples"]:
    key = row["base"], row["version"]
    r = row["round"]
    assert r not in rows[key] and row["firstResultMs"] > row["loadMs"] > 0
    rows[key][r] = row
    order[row["base"], r].append((row["position"], row["version"]))
    for req in row["requests"]:
        assert req["transferred"] > 0 and req["bytes"] == run["manifest"][req["path"]]["bytes"]
        assert len(run["manifest"][req["path"]]["sha256"]) == 64
cases = sorted({base for base, mode in rows})
rounds = run["rounds"]
assert len(cases) == 6 and set(modes) == {mode for base, mode in rows}
for base in cases:
    positions, transitions = Counter(), Counter()
    for r in range(rounds):
        group = sorted(order[base, r])
        assert len(group) == 4 and group[-1][0] == group[0][0] + 3
        labels = [m for _, m in group]
        positions.update(enumerate(labels))
        transitions.update(zip(labels, labels[1:]))
    assert len(positions) == 16 and set(positions.values()) == {rounds // 4}
    assert len(transitions) == 12 and set(transitions.values()) == {rounds // 4}

def metrics(row):
    js = [q for q in row["requests"] if q["path"].endswith(".js")]
    return (len(js), sum(q["bytes"] for q in js)/1024, row["loadMs"], row["firstResultMs"])
for mode in modes:
    absolute = [median(median(metrics(x)[i] for x in rows[base,mode].values()) for base in cases) for i in range(4)]
    print(mode, "requests, JS KiB, import ms, first result ms:", *(round(x, 3) for x in absolute))
rank = max(i for i in range(rounds) if 2*sum(comb(rounds,j) for j in range(i+1))/2**rounds <= .05)
print("| Guest and workload | Import after / before | First result after / before |")
print("| --- | ---: | ---: |")
for base in cases:
    cells = []
    for field in ("loadMs", "firstResultMs"):
        ratios = sorted(rows[base,"after"][r][field]/rows[base,"before"][r][field] for r in range(rounds))
        cells.append(f"{median(ratios):.2f}× ({ratios[rank]:.2f}–{ratios[-1-rank]:.2f})")
    print("|", " | ".join([base.strip("/"), *cells]), "|")
# All six cases share a browser process in each round. Give each round one
# observation when estimating the typical ratio over this workload mix.
for field in ("loadMs", "firstResultMs"):
    ratios = sorted(median(rows[base, "after"][r][field] / rows[base, "before"][r][field] for base in cases)
                    for r in range(rounds))
    print(field, "round-median ratio and interval:", *(f"{v:.3f}" for v in (median(ratios), ratios[rank], ratios[-1-rank])))
