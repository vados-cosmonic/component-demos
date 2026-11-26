"""Summarize provider-startup.mjs results and check the balanced design."""
import argparse
import gzip
import json
from collections import Counter, defaultdict
from math import comb
from pathlib import Path
from statistics import median

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("input", nargs="?", type=Path, default=Path(__file__).parent / "results/provider-startup.json.gz")
parser.add_argument("--plot", type=Path, help="Write a PNG of time to first result and JavaScript bytes")
args = parser.parse_args()
path = args.input
with gzip.open(path, "rt") as f:
    run = json.load(f)
rounds = run["rounds"]
rows = run["samples"]
variants = ["release", "bundled", "external", "shared"]
steps = defaultdict(list)
by_case = defaultdict(list)
positions = defaultdict(Counter)
pairs = defaultdict(dict)
for row in rows:
    case, version = row["base"], row["version"]
    positions[case][version, row["position"] % 4] += 1
    steps[case, row["round"]].append((row["position"], version))
    assert len(row["pair"]) == 2
    assert version not in pairs[case, row["round"]]
    pairs[case, row["round"]][version] = row["pair"]
    for i, sample in enumerate(row["pair"]):
        reqs = sample["requests"]
        scripts = [r for r in reqs if r["path"].endswith(".js")]
        assert len({r["path"] for r in reqs}) == len(reqs)
        assert all(r["bytes"] == run["manifest"][r["path"]]["bytes"] and r["transferred"] > 0 for r in reqs)
        assert any(r["path"].startswith("/runtime/") for r in scripts) == (version in ("external", "shared") and i == 0)
        if version == "shared" and i == 0:
            assert [r["path"] for r in scripts if r["path"].startswith("/runtime/")] == ["/runtime/shared-provider.js"]
        by_case[version, i, case].append([sample["loadMs"], sample["firstResultMs"], len(scripts),
            sum(r["bytes"] for r in scripts) / 1024, sum(run["manifest"][r["path"]]["gzip"] for r in scripts) / 1024])
cases = sorted(positions)
assert len(rows) == len(cases) * len(variants) * rounds
assert all(len(group) == 16 and set(group.values()) == {rounds // 4} for group in positions.values())
for case in cases:
    successors = Counter()
    for n in range(rounds):
        values = [v for _, v in sorted(steps[case, n])]
        successors.update(zip(values, values[1:]))
    assert len(successors) == 12 and set(successors.values()) == {rounds // 4}
    for path, info in run["manifest"].items():
        if path.startswith(case + "/shared/"):
            assert info == run["manifest"][path.replace("/shared/", "/external/")]
assert all(len(values) == rounds for values in by_case.values())
assert all(set(versions) == set(variants) for versions in pairs.values())
print("| Build | Component | Import (ms) | First result (ms) | JS requests | JS (KiB) | JS gzip (KiB) |")
print("| --- | --- | ---: | ---: | ---: | ---: | ---: |")
labels = {"release": "Jco 1.13.0", "bundled": "PR bundled", "external": "PR external", "shared": "PR external, packed provider"}
summary = {}
for version in variants:
    for i, phase in enumerate(["First", "Second"]):
        stats = [median(median(v[k] for v in by_case[version, i, case]) for case in cases) for k in range(5)]
        summary[version, i] = stats
        print(f"| {labels[version]} | {phase} | {stats[0]:.2f} | {stats[1]:.2f} | {stats[2]:g} | {stats[3]:.1f} | {stats[4]:.1f} |")
for i, phase in enumerate(["first", "second"]):
    for treatment, baseline in [("external", "bundled"), ("shared", "external"), ("shared", "bundled"), ("shared", "release")]:
        for key in ["loadMs", "firstResultMs"]:
            distributions = [sorted(pairs[case, n][treatment][i][key] / pairs[case, n][baseline][i][key]
                                    for n in range(rounds)) for case in cases]
            ratios = list(map(median, distributions))
            print(f"{phase} {key}, {treatment} / {baseline}: {median(ratios):.3f}, earlier in {sum(r <= 1 for r in ratios)}/{len(ratios)}")
            # At 12 rounds, the third and tenth ordered observations bound a median with 96.1% coverage.
            eligible = [k for k in range(rounds // 2) if 2 * sum(comb(rounds, j) for j in range(k + 1)) <= 0.05 * 2**rounds]
            if eligible:
                k = max(eligible)
                print(f"  95% sign-test intervals below / above parity: "
                      f"{sum(d[-k-1] < 1 for d in distributions)} / {sum(d[k] > 1 for d in distributions)}")

if args.plot:
    import matplotlib.pyplot as plt

    labels["shared"] = "PR external, packed"
    fig, axes = plt.subplots(1, 2, figsize=(9.4, 3.3), sharey=True, layout="constrained")
    for ax, column, title in zip(axes, [1, 3], ["Time to first guest result (ms)", "JavaScript loaded (KiB)"]):
        for i, label, color in [(0, "First component", "#236687"), (1, "Second component", "#b4562c")]:
            values = [summary[v, i][column] for v in variants]
            bars = ax.barh([n + (i - 0.5) * 0.36 for n in range(len(variants))], values,
                           height=0.33, label=label, color=color)
            ax.bar_label(bars, fmt="%.1f", fontsize=8, padding=3)
        ax.set_title(title)
        ax.set_xlim(0, ax.get_xlim()[1] * 1.12)
        ax.spines[["top", "right"]].set_visible(False)
    axes[0].set_yticks(range(len(variants)), [labels[v] for v in variants])
    axes[0].invert_yaxis()
    axes[1].legend(loc="lower right", fontsize=8)
    fig.savefig(args.plot, dpi=160)
