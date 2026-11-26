"""Check the guest-specific task experiment and report the paired browser timings."""
from sign_interval import median_sign_index
import argparse
import gzip
from collections import Counter
from hashlib import sha256
import json
from pathlib import Path
from statistics import median

parser = argparse.ArgumentParser(description=__doc__)
for name in ["matrix", "reference", "runner", "trace", "small", "full"]:
    parser.add_argument(name, type=Path)
args = parser.parse_args()
read = lambda p: json.loads(gzip.decompress(p.read_bytes()))
digest = lambda p: sha256(p.read_bytes()).hexdigest()
matrix, reference = read(args.matrix), read(args.reference)
assert reference["matrix"] == digest(args.matrix)
builds, langs = ["release","bundled","external"], ["c","cpp","rust"]

def interval(values):
    ordered = sorted(values)
    n = len(ordered)
    rank = median_sign_index(n)
    return f"{median(ordered):.3f} ({ordered[rank]:.3f}–{ordered[-1-rank]:.3f})"

assets = None
for study in ["trace","small","full"]:
    data = read(getattr(args,study))
    assert data["study"] == study and data["runner"] == digest(args.runner)
    assert data["matrix"] == digest(args.matrix) and data["reference"] == digest(args.reference)
    assert data["helper"] == digest(Path(__file__).with_name("init-task-probe.mjs"))
    assert data["chromium"] == matrix["chromium"] and data["revision"] == matrix["candidate"]
    if assets is None:
        assets = data["manifest"]
    assert data["manifest"] == assets
    assert data["rounds"] == (12 if study == "trace" else 20)
    for k in ["files","guests"]:
        assert data[k] == reference[k]
    for k,v in reference["manifest"].items(): assert data["manifest"][k] == v
    modes = [(b, "traced" if study=="trace" and b!="release" else "table_update") for b in builds]
    if study!="trace":
        modes += [(b,"omitted") for b in builds[1:]]
    rounds = 12 if study=="trace" else 20
    rows = {(s["lang"],s["build"],s["strategy"],s["round"]):s for s in data["samples"]}
    assert len(rows)==len(data["samples"])==rounds*len(modes)*len(langs)
    for lang in langs:
        starts = data["starts"][lang]
        wrapped = [name for name, core in starts.items() if core.get("start") is not None]
        assert wrapped == (["table_update.core.wasm"] if lang == "rust" else ["table_update.core4.wasm"])
        if lang=="rust":
            functions = ["$__wasm_init_memory"]
        else:
            functions = ["$_initialize","$__wasm_call_ctors","$__wasi_init_tp"]
        assert sorted(data["starts"][lang]["table_update.core.wasm"]["examined"])==sorted(functions)
        adjacency=Counter()
        for r in range(rounds):
            order=sorted((rows[lang,b,s,r]["pos"],(b,s)) for b,s in modes)
            assert [p for p,_ in order]==list(range(len(modes)))
            adjacency.update((a[1],b[1]) for a,b in zip(order,order[1:]))
        assert len(adjacency)==len(modes)*(len(modes)-1) and set(adjacency.values())=={rounds//len(modes)}
        for b,s in modes:
            rr=[rows[lang,b,s,r] for r in range(rounds)]
            assert set(Counter(row["pos"] for row in rr).values())=={rounds//len(modes)}
            assert all(abs(row["readyMs"]+row["callMs"]-row["firstMs"])<1e-6 for row in rr)
    print(study,"documents",len(rows))
    if study=="trace":
        for build in builds[1:]:
            def boundaries(lang,r):
                row=rows[lang,build,"traced",r]
                events=row["events"]
                times={e["label"]:e["time"] for e in events}
                assert len(times)==len(events) and list(times.values())==sorted(times.values())
                assert list(times.values())[-1]<=row["readyMs"]
                spans={"before first generated statement":times["entered instantiate"]}
                for label in ["task setup","clear task registers","resolve task","exit task"]+(
                        ["initializeRepTableClass","initializeComponentAsyncStateClass","initializeAsyncTaskClass",
                         "initializeAsyncThreadClass"] if build=="external" else []):
                    spans[label]=times[label+" end"]-times[label+" start"]
                spans["total setup before lookup"]=times["lookup table_update.core.wasm"]
                return spans
            for key in boundaries(langs[0],0):
                print(build,key,"ms",interval(median(boundaries(l,r)[key] for l in langs) for r in range(rounds)))
        continue
    for build in builds[1:]:
        for field in ["readyMs","callMs","firstMs"]:
            for lang in langs+["suite"]:
                which=langs if lang=="suite" else [lang]
                def paired(r,denom="same",ratio=True):
                    control=(build if denom=="same" else "release","table_update")
                    a=[rows[l,build,"omitted",r][field] for l in which]
                    b=[rows[l,*control,r][field] for l in which]
                    return median((x/y if ratio else x-y) for x,y in zip(a,b,strict=True))
                typical=median(median(rows[l,build,"table_update",r][field] for l in which) for r in range(rounds))
                print(lang,build,field,"control ms",round(typical,2),"omitted / control",interval(paired(r) for r in range(rounds)),
                      "ms saved",interval(-paired(r,ratio=False) for r in range(rounds)),"omitted / release",interval(paired(r,"release") for r in range(rounds)))
