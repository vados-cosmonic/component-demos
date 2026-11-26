"""Verify the staged builds and summarize the paired class-definition trials."""
from sign_interval import median_sign_index
import argparse
from collections import Counter
import gzip
from hashlib import sha256
import json
from math import isclose
from pathlib import Path
from statistics import median

parser = argparse.ArgumentParser(description=__doc__)
for arg in ("control", "matrix", "prior", "startup"):
    parser.add_argument(arg, type=Path)
args = parser.parse_args()
bench = Path(__file__).resolve().parent
digest = lambda p: sha256(p.read_bytes()).hexdigest()
load = lambda p: json.loads(gzip.decompress(p.read_bytes()))
control, matrix, prior, startup = (load(p) for p in (args.control, args.matrix, args.prior, args.startup))
for k in ("workloads", "rounds", "upstream", "commonBase", "candidate", "runnerSha256", "inventorySha256", "checkedPackage"):
    assert control[k] == matrix[k], k
same_environment = all(control[k] == matrix[k] for k in ("chromium", "cpu", "node"))
same_tools = all(control["compilers"][k] == matrix["compilers"][k] for k in ("main", "bundled"))
assert matrix["compilers"]["previous"] != matrix["compilers"]["bundled"]
original = lambda m: {k:v for k,v in m["manifest"].items() if "/previous-" not in k}
assert original(control) == original(matrix)
assert startup["matrix"] == digest(args.matrix) and startup["prior"] == digest(args.prior)
assert startup["runner"] == digest(bench / "class-definition-startup.mjs")
assert startup["patch"] == digest(bench / "experiments/eager-class-definitions.patch")
assert prior["matrix"] == digest(args.control)
assert matrix["runnerSha256"] == digest(bench / "review-matrix.mjs")
assert startup["chromium"] == matrix["chromium"]
langs = ["c", "cpp", "rust"]
focus = {"attribute-churn":"per setAttribute()", "canvas-draw":"per fill_rect()", "canvas-pixels":"getImageData(): µs/call",
         "dom-query":"individual: µs/element", "dom-traversal":"traverse (total)", "string-marshalling":"get 1024 B", "table-update":"create: total ms"}
assert focus.keys() == matrix["workloads"].keys()

def bounds(values):
    ordered = sorted(values)
    n = len(ordered)
    k = median_sign_index(n)
    return median(ordered), ordered[k], ordered[-1-k]

def interval(values):
    mid, low, high = bounds(values)
    return f"{mid:.3f} ({low:.3f}–{high:.3f})"

rounds = matrix["rounds"]
rows = {(s["demo"],s["lang"],s["version"],s["round"]):s for s in matrix["samples"]}
assert len(rows) == len(matrix["samples"]) == 1668 and rounds == 12
for b in ["bundled", "external"]:
    for key in ["loadMs","firstResultMs","warm"]:
        ratios = []
        for r in range(rounds):
            values = []
            for d, metric in focus.items():
                for l in langs:
                    control_row, trial_row = (rows[d,l,v,r] for v in (b,"previous-"+b))
                    get = lambda s: s["warm"][metric] if key=="warm" else s[key]
                    values.append(get(trial_row)/get(control_row))
            ratios.append(median(values))
        print("full matrix", b, key, "trial / stock",interval(ratios))
    sizes=[]
    for d in focus:
        for l in langs:
            old,new = (rows[d,l,v,0] for v in (b,"previous-"+b))
            stem = lambda p: p.split("/")[-1]
            def guest(s):
                return {stem(q["path"]):matrix["manifest"][q["path"]]["sha256"] for q in s["requests"] if q["path"].endswith(".wasm")}
            assert guest(old)==guest(new)
            if b=="external":
                assert matrix["manifest"][old["entry"]] == matrix["manifest"][new["entry"]]
            def payload(s,k):
                return sum(matrix["manifest"][q["path"]][k] for q in s["requests"] if q["path"].endswith(".js"))
            sizes.append([payload(new,k)-payload(old,k) for k in ["bytes","gzip"]])
    print("full matrix", b, "raw/gzip JS byte changes min/median/max",[[min(c), median(c),max(c)] for c in zip(*sizes)])
# The experimental arms differ in these two matrices. Every asset and compiler
# for the shipping arms matched above, so compare each to its own release control.
if same_environment and same_tools:
    initial = {(s["demo"],s["lang"],s["version"],s["round"]):s for s in control["samples"]}
    for build in ["bundled", "external"]:
        for phase in ["warm", "firstResultMs", "loadMs", "callMs"]:
            confirmed, typical_delta = [], []
            for demo, metric in focus.items():
                for lang in langs:
                    diffs = []
                    for run in (initial, rows):
                        ratios, deltas = [], []
                        for r in range(rounds):
                            values = [run[demo,lang,v,r] for v in (build,"release")]
                            if phase == "callMs":
                                a,b = [s["firstResultMs"] - s["loadMs"] for s in values]
                            else:
                                a,b = [s["warm"][metric] if phase=="warm" else s[phase] for s in values]
                            ratios.append(a/b)
                            deltas.append(a-b)
                        if bounds(ratios)[1] > 1:
                            diffs.append(median(deltas))
                    if len(diffs) == 2:
                        confirmed.append(lang+"/"+demo)
                        typical_delta.append(diffs[1])
            print("two runs", build, phase, "both intervals wholly slower than release", len(confirmed), confirmed)
            if phase=="firstResultMs" and confirmed:
                print("repeat run median additional first-result ms for those workloads", median(typical_delta))

rows={(s["name"],s["version"],s["round"]):s for s in startup["samples"]}
rounds=startup["rounds"]
assert len(rows)==len(startup["samples"])==420 and rounds==20
for name in langs+["intrinsics/core", "intrinsics/component", "intrinsics/sync-task"]:
    standalone=name not in langs
    modes=["stock","trial"] if standalone else ["release","stock-internal","trial-internal","stock-external","trial-external"]
    predecessors=Counter()
    for r in range(rounds):
        order=sorted((rows[name,v,r]["position"],v) for v in modes)
        assert [i for i,_ in order]==list(range(len(modes)))
        predecessors.update((a[1],b[1]) for a,b in zip(order,order[1:]))
    assert len(predecessors)==len(modes)*(len(modes)-1) and set(predecessors.values())=={rounds//len(modes)}
    for v in modes:
        assert Counter(rows[name,v,r]["position"] for r in range(rounds))=={i:rounds//len(modes) for i in range(len(modes))}
        if not standalone:
            for r in range(rounds):
                s=rows[name,v,r]
                assert min(s[k] for k in ["importMs","instanceMs","callMs"])>0 and isclose(s["firstMs"],s["importMs"]+s["instanceMs"]+s["callMs"])
    if standalone:
        for key in ["firstMs","retainedBytes"]:
            a,b=([rows[name,v,r][key] for r in range(rounds)] for v in modes)
            print(name,key,"stock / trial medians",round(median(a),3),round(median(b),3),"paired trial minus stock",interval(y-x for x,y in zip(a,b,strict=True)))
for mode in ["internal","external"]:
    for key in ["importMs","instanceMs","callMs","firstMs"]:
        ratios=[];diffs=[]
        for r in range(rounds):
            a=[rows[l,"stock-"+mode,r][key] for l in langs]
            b=[rows[l,"trial-"+mode,r][key] for l in langs]
            ratios.append(median(y/x for x,y in zip(a,b,strict=True)))
            diffs.append(median(y-x for x,y in zip(a,b,strict=True)))
        print("precompiled",mode,key,"trial / stock",interval(ratios),"paired ms change",interval(diffs))
