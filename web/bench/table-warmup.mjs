// Isolate prior work on the DOM from prior calls through the same guest component.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import puppeteer from "puppeteer-core";

const [checkout, matrixPath, output, mode, ...extra] = process.argv.slice(2);
assert(
  output && !extra.length,
  "Usage: table-warmup.mjs <built Jco checkout> <matrix.json.gz> <output.json.gz> [trace-directory | --time-weak-adds | --stages | --drop-history-control]",
);
const language = process.env.GUEST_LANGUAGE ?? "rust";
assert(["c", "cpp", "rust"].includes(language), "GUEST_LANGUAGE must be c, cpp or rust");
const timeWeakAdds = mode === "--time-weak-adds";
const dropHistoryControl = mode === "--drop-history-control";
const measureStages = mode === "--stages" || dropHistoryControl;
if (measureStages) assert.equal(language, "c", "The stage probe uses the C guest's named marks");
const traceDir = timeWeakAdds || measureStages ? undefined : mode;
if (traceDir) await mkdir(traceDir, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const matrixBytes = await readFile(matrixPath);
const matrix = JSON.parse(gunzipSync(matrixBytes));
const bench = import.meta.dirname,
  web = join(bench, "..");
const versions = ["release", "bundled", "external"],
  warmups = ["none", "js", "guest"];
const treatments = dropHistoryControl
  ? versions.flatMap(version => (version === "release" ? ["normal"] : ["normal", "omit", "grouped"])
      .map(history => ({ version, warmup: "none", history })))
  : versions.flatMap((version) => warmups.map((warmup) => ({ version, warmup })));
const cases = matrix.samples.filter(
  (r) =>
    r.round === 0 && r.lang === language && r.demo === "table-update" && versions.includes(r.version),
);
assert.equal(cases.length, versions.length);
const rows = matrix.workloads["table-update"].rows;
const assets = new Map(),
  imports = {},
  entries = {},
  expected = {};
function add(path, bytes) {
  assert.equal(hash(bytes), matrix.manifest[path].sha256, path);
  assets.set(path, bytes);
}
for (const path of ["/host/web-host.js", "/host/common.js", "/examples/table-update/main.js"])
  add(path, await readFile(join(web, path)));
const map = Object.fromEntries(
  (await readFile(join(web, "host/imports.txt"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const [key, name] = line.split(/\s+/);
      return [key, "../../../host/web-host.js#" + name];
    }),
);
const { transpileBytes } = await import(
  pathToFileURL(resolve(checkout, "packages/jco-transpile/dist/transpile.js"))
);
const guest = await readFile(join(web, language, "table-update/native/table_update.wasm"));
for (const { version, entry, requests } of cases) {
  entries[version] = entry;
  expected[version] = requests.map((r) => r.path).sort();
  const options = {
    name: "table_update",
    minify: true,
    map,
    base64Cutoff: 5000,
    emitTypescriptDeclarations: false,
    namespacedExports: true,
    nodejsCompat: false,
  };
  if (version === "external") options.cmRuntimeEsModule = matrix.checkedPackage;
  const files = version === "release" ? null : (await transpileBytes(guest, options)).files;
  for (const { path } of requests) {
    if (path.startsWith("/runtime/")) {
      const file = path.slice(9);
      add(path, await readFile(join(checkout, "packages/jco-cm-runtime/dist", file)));
      imports[matrix.checkedPackage + "/" + file.slice(0, -3)] = path;
    } else {
      add(
        path,
        files
          ? files[basename(path)]
          : await readFile(join(web, language, "table-update/jco-baseline-minified", basename(path))),
      );
    }
  }
}

// The diagnostic variant deletes only the history write from each generated
// destructor. Guest drops, table removal and host hooks still execute. A real
// store needs the history when stopping with another alias of a dropped object.
const modifiedEntries = new Map();
const modifications = {};
if (dropHistoryControl) {
  for (const version of ["bundled", "external"]) {
    const entry = entries[version], original = Buffer.from(assets.get(entry)).toString("utf8");
    const writes = /([$\w]+)\.disposed\.add\(([$\w]+)\),/g;
    const calls = [...original.matchAll(writes)];
    assert(calls.length > 0 && calls.length === original.split(".disposed.add(").length - 1);
    for (const match of calls) {
      assert(original.slice(match.index + match[0].length).startsWith(match[2] + "["),
        "Each write must immediately precede disposal of the same object");
    }
    // Compare the cost of one growing weak set with eight smaller ones. Each
    // 1,024-insertion block goes to one bucket. Only shutdown scans all eight.
    // The experimental bindings have a single store. Keep its original set
    // so any entry added there before the first guest drop is still visible.
    const groupHelper = `
var _benchGroupHistory;
function _benchMakeGroupHistory(store) {
  const original = store.disposed, buckets = Array.from({length: 8}, () => new WeakSet());
  let position = 0;
  return store.disposed = {
    add(value) {
      buckets[position >>> 10].add(value);
      position = (position + 1) & 8191;
      return this;
    },
    has(value) { return original.has(value) || buckets.some(bucket => bucket.has(value)); },
    delete(value) {
      let removed = original.delete(value);
      for (const bucket of buckets) if (bucket.delete(value)) removed = true;
      return removed;
    }
  };
}`;
    assert(!original.includes("_benchGroupHistory") && !original.includes("_benchMakeGroupHistory"));
    const omit = original.replace(writes, "");
    const grouped = original.replace(writes, "(_benchGroupHistory??=_benchMakeGroupHistory($1)).add($2),") + "\n" + groupHelper;
    modifiedEntries.set(entry, { omit, grouped });
    modifications[version] = { sites: calls.length, original: hash(original), omit: hash(omit), grouped: hash(grouped) };
  }
}

async function measure({ entry, warmup, rows, calls, audit, stopAudit, timeWeakAdds, measureStages, dropHistoryControl }) {
  const { runRawJs, getMeasurements } = await import("/examples/table-update/main.js");
  // Match the matrix: the shared host is present before import and each call
  // starts with a clean body and empty user-timing buffers.
  await import("/host/web-host.js");
  performance.clearResourceTimings();
  const { run, _util } = await import(entry);
  const requests = performance
    .getEntriesByType("resource")
    .map((r) => new URL(r.name).pathname)
    .sort();
  if (stopAudit) {
    // appendChild returns the heading while the C guest still owns its first
    // handle. Stop in the disposal getter when the guest drops the second handle.
    const key = Symbol.dispose ?? Symbol.for("dispose");
    const createElement = Document.prototype.createElement;
    let disposals = 0, stopping = false, trapped = false;
    Document.prototype.createElement = function(name, ...args) {
      const element = createElement.call(this, name, ...args);
      if (name === "h2") Object.defineProperty(element, key, {
        get() {
          if (!stopping) { stopping = true; _util.stop(); }
          return () => { disposals++; };
        }
      });
      return element;
    };
    try { run(rows); } catch (e) { if (!String(e).includes("instance has been stopped")) throw e; trapped = true; }
    return { requests, disposals, stopping, trapped };
  }
  const counts = { createElement: 0, setTextContent: 0, appendChild: 0 };
  let active = false, historyWrites = 0;
  if (audit && dropHistoryControl) {
    const add = WeakSet.prototype.add;
    WeakSet.prototype.add = function(value) {
      if (active) historyWrites++;
      return add.call(this, value);
    };
  }
  if (audit) {
    // This document is never timed. Count host calls and inspect the live rows
    // before the guest removes its working table to publish its result.
    const mark = Performance.prototype.mark;
    Performance.prototype.mark = function (name, ...args) {
      if (name === "create-start") active = true;
      if (name === "create-end") {
        active = false;
        const body = document.querySelector("details tbody");
        if (
          body.children.length !== rows ||
          body.firstElementChild.textContent !== "row 1" ||
          body.lastElementChild.textContent !== "row " + rows
        )
          throw Error("Incorrect created rows");
      }
      return mark.call(this, name, ...args);
    };
    for (const [proto, name] of [
      [Document.prototype, "createElement"],
      [Node.prototype, "setTextContent"],
      [Node.prototype, "appendChild"],
    ]) {
      const original = proto[name];
      proto[name] = function (...args) {
        if (active) counts[name]++;
        return original.apply(this, args);
      };
    }
  }
  const weakAdds = [];
  let current;
  if (timeWeakAdds && !audit) {
    // Instrument a separate run. Calls to the clock add overhead, so compare
    // individual insertions here and use the untouched run for elapsed time.
    const add = WeakSet.prototype.add;
    WeakSet.prototype.add = function (value) {
      if (!current) return add.call(this, value);
      const t = performance.now();
      const result = add.call(this, value);
      const ms = performance.now() - t;
      current.count++;
      current.totalMs += ms;
      current.longestMs = Math.max(current.longestMs, ms);
      return result;
    };
    const mark = Performance.prototype.mark;
    Performance.prototype.mark = function (name, ...args) {
      if (name === "create-start") current = { count: 0, totalMs: 0, longestMs: 0 };
      if (name === "create-end") {
        weakAdds.push(current);
        current = undefined;
      }
      return mark.call(this, name, ...args);
    };
  }
  const stages = [];
  function invoke(fn, recordStages = false) {
    document.body.replaceChildren();
    performance.clearMeasures();
    performance.clearMarks();
    const start = recordStages ? performance.now() : 0;
    fn(rows);
    if (recordStages) {
      const end = performance.now();
      // Read the guest's existing marks only after it returns. In particular,
      // c-end precedes the final drops of the retained row and cell handles.
      const marks = Object.fromEntries(performance.getEntriesByType("mark").map(m => [m.name, m.startTime]));
      const names = ["c-start", "create-start", "create-end", "update-start", "update-end", "clear-start", "clear-end", "c-end"];
      const times = [start, ...names.map(name => marks[name]), end];
      if (!times.every((value, i) => Number.isFinite(value) && (i === 0 || times[i-1] <= value)))
        throw Error("Missing or out-of-order C guest marks");
      stages.push(Object.fromEntries(["entry", ...names, "return"].map((name, i) => [name, times[i] - start])));
    }
    const reports = Object.values(getMeasurements());
    if (
      reports.length !== 1 ||
      Object.keys(reports[0]).length !== 6 ||
      !Object.values(reports[0]).every((n) => Number.isFinite(n) && n > 0)
    )
      throw Error("Invalid guest timing report");
    return reports[0];
  }
  if (audit) {
    invoke(run);
    return { counts, requests, ...(dropHistoryControl && { historyWrites }) };
  }
  if (warmup !== "none") {
    const prepare = warmup === "js" ? runRawJs : run;
    for (let i = 0; i < 4; i++) invoke(prepare);
  }
  weakAdds.length = 0;
  const measurements = [];
  for (let i = 0; i < calls; i++) measurements.push(invoke(run, measureStages));
  if (measureStages) return { measurements, requests, stages };
  return timeWeakAdds ? { measurements, requests, weakAdds } : { measurements, requests };
}

const calls = 24;
const rounds = dropHistoryControl ? 28 : 18,
  samples = [],
  audits = [];
let chromium;
for (let round = 0; round < rounds; round++) {
  // Rotate a balanced order and its reverse for each odd-sized design.
  const n = treatments.length;
  const sequence = Array.from({ length: n }, (_, i) => i % 2 ? (i + 1) / 2 : (n - i / 2) % n);
  if (Math.floor(round / n) % 2) sequence.reverse();
  const queue = sequence.map(i => treatments[(i + round) % n]);
  if (round === rounds - 1) {
    const checks = dropHistoryControl ? treatments : versions.map(version => ({ version }));
    queue.push(...checks.map(trial => ({ ...trial, audit: true })));
  }
  if (dropHistoryControl && round === 0)
    queue.push(...treatments.filter(t => t.version !== "release").map(t => ({ ...t, stopAudit: true })));
  const gate = Promise.withResolvers(),
    done = Promise.withResolvers();
  done.promise.catch(() => {});
  let position = 0;
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      if (assets.has(path)) {
        res.setHeader(
          "Content-Type",
          path.endsWith(".wasm") ? "application/wasm" : "text/javascript",
        );
        return res.end(modifiedEntries.get(path)?.[queue[position]?.history] ?? assets.get(path));
      }
      if (path === "/")
        return res.end('<script>fetch("/gate").then(()=>location.replace("/trial/0"))</script>');
      if (path === "/gate") {
        await gate.promise;
        return res.end();
      }
      const trial = queue[position];
      if (trial && path === "/trial/" + position) {
        res.setHeader("Content-Type", "text/html");
        const args = { ...trial, entry: entries[trial.version], rows, calls, timeWeakAdds, measureStages, dropHistoryControl };
        return res.end(
          '<!doctype html><head><script type="importmap">' +
            JSON.stringify({ imports }) +
            '</script></head><body><script type="module">try {const data=await (' +
            measure.toString() +
            ")(" +
            JSON.stringify(args) +
            ');const r=await fetch("/result",{method:"POST",body:JSON.stringify(data)});const next=await r.text();if(next)location.replace(next);}catch(e){await fetch("/error",{method:"POST",body:String(e.stack||e)});}</script></body>',
        );
      }
      if (path === "/error" || path === "/result") {
        let body = "";
        for await (const chunk of req) body += chunk;
        if (path === "/error") throw Error(body);
        const data = JSON.parse(body);
        assert.deepEqual(data.requests, expected[trial.version]);
        if (trial.stopAudit) {
          assert(data.trapped && data.stopping);
          assert.equal(data.disposals, trial.history === "omit" ? 2 : 1);
          audits.push({ version: trial.version, history: trial.history, stopAudit: true, ...data });
        } else if (trial.audit) {
          assert.deepEqual(data.counts, {
            createElement: 2 * rows,
            setTextContent: rows,
            appendChild: 2 * rows,
          });
          if (dropHistoryControl)
            assert.equal(data.historyWrites, trial.history === "omit" || trial.version === "release" ? 0 : 2 * rows + 1);
          audits.push({ version: trial.version, ...(dropHistoryControl && { history: trial.history }), ...data });
        } else samples.push({ round, position, ...trial, ...data });
        position++;
        res.end(position < queue.length ? "/trial/" + position : "");
        if (position === queue.length) done.resolve();
        return;
      }
      res.writeHead(404).end();
    } catch (error) {
      res.writeHead(500).end();
      done.reject(error);
    }
  });
  let browser, endpoint;
  const timer = setTimeout(
    () => done.reject(Error("Timed out waiting for page " + position)),
    120000,
  );
  try {
    await new Promise((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
    browser = await puppeteer.launch({
      executablePath: process.env.CHROME_BIN,
      args: [
        ...(process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
        ...(traceDir
          ? [
              "--trace-startup=-*,v8,devtools.timeline,blink.user_timing,disabled-by-default-v8.compile",
              "--trace-startup-duration=0",
              "--trace-startup-format=json",
              "--trace-startup-file=" + resolve(traceDir, "round-" + round + ".json"),
            ]
          : []),
      ],
    });
    chromium = await browser.version();
    await (await browser.newPage()).goto("http://127.0.0.1:" + server.address().port);
    endpoint = browser.wsEndpoint();
    await browser.disconnect();
    gate.resolve();
    await done.promise;
  } finally {
    clearTimeout(timer);
    gate.resolve();
    try {
      if (endpoint) browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
      await browser?.close();
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }
  console.log("Completed browser", round + 1, "of", rounds);
}
await writeFile(
  output,
  gzipSync(
    JSON.stringify({
      rounds,
      rows,
      language,
      versions,
      warmups,
      chromium,
      traced: Boolean(traceDir),
      timeWeakAdds,
      measureStages,
      ...(dropHistoryControl && { dropHistoryControl, modifications }),
      calls,
      revision: matrix.candidate,
      matrixSha256: hash(matrixBytes),
      runnerSha256: hash(await readFile(import.meta.filename)),
      samples,
      audits,
    }),
  ),
);
