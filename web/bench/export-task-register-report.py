"""Report paired page timings from export-task-register.mjs."""
import argparse
import gzip
import json
from collections import defaultdict
from math import comb
from statistics import median

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("archive")
with gzip.open(parser.parse_args().archive, "rt") as source:
    run = json.load(source)

rounds = run["rounds"]
pages = defaultdict(dict)
for row in run["samples"]:
    passes = pages[row["mode"], row["round"]]
    assert row["pass"] not in passes and row["ns"] > 0
    passes[row["pass"]] = row["ns"]
assert len(run["allocations"]) == rounds
assert all(set(values) == set(range(6, 12)) for values in pages.values())
times = {mode: [median(pages[mode, i].values()) for i in range(rounds)] for mode in run["modes"]}

# Repeated passes in one document share a JS engine. Give each page one vote.
rank = max(i for i in range(rounds)
           if 2 * sum(comb(rounds, j) for j in range(i + 1)) <= 0.05 * 2**rounds)
print("Median ns per complete round trip")
for mode, values in times.items():
    print(f"{mode}: {median(values):.1f}")

print("| Renderer | Globals before → after | Entry bytes saved (gzip) | After / before (95% interval) | After / release | After / direct |")
print("| --- | ---: | ---: | ---: | ---: | ---: |")
def paired_ratio(current, reference):
    return sorted(a / b for a, b in zip(times[current], times[reference], strict=True))


for build in ["internal", "external"]:
    before, after = "before-" + build, "after-" + build
    counts = {(a[before], a[after]) for a in run["allocations"]}
    assert counts == {(1, 0)}
    sizes = run["sizes"]
    saved = {key: sizes[before][key] - sizes[after][key] for key in ["bytes", "gzip"]}
    delta = paired_ratio(after, before)
    print(f"| {build} | 1 → 0 | {saved['bytes']} ({saved['gzip']}) "
          f"| {median(delta):.3f}× ({delta[rank]:.3f}–{delta[-1-rank]:.3f}) "
          f"| {median(paired_ratio(after, 'release')):.2f}× | {median(paired_ratio(after, 'direct')):.2f}× |")
