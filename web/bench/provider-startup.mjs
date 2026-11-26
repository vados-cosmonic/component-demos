// Measure first use of the checked runtime and its reuse by a second component in the same document.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { cpus, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import puppeteer from "puppeteer-core";
import { bundleCompleteProvider, bundleSharedProvider } from "./shared-provider.mjs";

const [checkout, generator, output, mode] = process.argv.slice(2);
assert([undefined, "--allocations", "--all-exports"].includes(mode));
const countAllocations = mode === "--allocations";
assert(checkout && generator && output, "Usage: provider-startup.mjs <jco-checkout> <native-generator-or-transpile.js> <results.json.gz> [--allocations | --all-exports]");
const rounds = Number(process.env.ROUNDS ?? 12);
assert(Number.isSafeInteger(rounds) && rounds > 0 && rounds % 4 === 0);
const web = join(import.meta.dirname, "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
const revision = git("rev-parse", "HEAD");
const inventory = JSON.parse(await readFile(join(web, "bench/results/candidate-sizes.json")));
const workload = { "attribute-churn": [8, 2], "canvas-draw": [16], "dom-query": [8, 2],
  "dom-traversal": [2, 2], "table-update": [8] };
const assets = new Map();
const manifest = {};
function register(path, bytes) {
  assets.set(path, bytes);
  manifest[path] = { bytes: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length, sha256: hash(bytes) };
}
const imports = Object.fromEntries((await readFile(join(web, "host/imports.txt"), "utf8")).trim().split("\n").map(line => {
  const [name, symbol] = line.split(/\s+/);
  return [name, "../../../host/web-host.js#" + symbol];
}));
const mappings = Object.entries(imports).map(([name, value]) => "--map=" + name + "=" + value);
const transpiler = generator.endsWith(".js") ? await import(pathToFileURL(resolve(generator))) : undefined;
const runtime = join(checkout, "packages/jco-cm-runtime/dist");
for (const name of await readdir(runtime, { recursive: true })) {
  if (name.endsWith(".js") && !name.startsWith("debug/")) register("/runtime/" + name, await readFile(join(runtime, name)));
}
for (const path of ["host/web-host.js", "host/common.js", ...Object.keys(workload).map(demo => "examples/" + demo + "/main.js")]) {
  register("/" + path, await readFile(join(web, path)));
}

const variants = ["release", "bundled", "external", "shared"];
const cases = [];
const temp = await mkdtemp(join(tmpdir(), "jco-provider-startup-"));
try {
  for (const { input, variants: builds } of inventory.components) {
    const [lang, demo] = input.path.split("/");
    const name = basename(input.path, ".wasm");
    if (!(demo in workload) || name !== demo.replaceAll("-", "_")) continue;
    assert.equal(hash(await readFile(join(web, input.path))), input.sha256);
    const base = "/" + lang + "/" + demo;
    const coreHashes = {};
    for (const version of ["release", "bundled", "external"]) {
      const dir = join(temp, lang, demo, version);
      let files;
      if (version === "release") {
        files = await Promise.all(builds.baseline.map(async file => {
          const bytes = await readFile(join(web, file.path));
          assert.equal(hash(bytes), file.sha256);
          return [basename(file.path), bytes];
        }));
      } else if (transpiler) {
        const opts = { name, nodejsCompat: false, base64Cutoff: 5000, namespacedExports: true,
          emitTypescriptDeclarations: false, map: { ...imports } };
        if (version === "external") Object.assign(opts, { cmRuntimeEsModule: "/runtime", cmRuntimeSyncImports: true });
        const result = await transpiler.transpileBytes(await readFile(join(web, input.path)), opts);
        files = Object.entries(result.files).map(([file, bytes]) => [file, Buffer.from(bytes)]);
      } else {
        const flags = version === "external" ? ["--runtime=/runtime", "--cm-runtime-sync-imports"] : [];
        execFileSync(resolve(generator), [join(web, input.path), dir, "--name=" + name, "--no-nodejs-compat",
          "--base64-cutoff=5000", "--namespaced-exports", ...mappings, ...flags]);
        files = await Promise.all((await readdir(dir)).map(async file => [file, await readFile(join(dir, file))]));
      }
      const digests = {};
      for (const [file, bytes] of files) {
        register(base + "/" + version + "/" + file, bytes);
        if (version === "external") register(base + "/shared/" + file, bytes);
        if (file.endsWith(".wasm")) digests[file] = hash(bytes);
        else assert.equal(bytes.includes("/runtime/intrinsics/sync.js"), version === "external");
      }
      if (version === "release") Object.assign(coreHashes, digests);
      else assert.deepEqual(digests, coreHashes, input.path);
    }
    cases.push({ base, demo, name });
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
assert.equal(cases.length, Object.keys(workload).length * 3);
const shared = mode === "--all-exports" ? await bundleCompleteProvider(resolve(checkout), resolve(runtime)) : await bundleSharedProvider(resolve(checkout), resolve(runtime),
  cases.map(item => assets.get(item.base + "/external/" + item.name + ".js")));
register("/runtime/shared-provider.js", shared.bytes);

// These counters are restricted to the explicit allocation study. Interposing on a
// constructor can change the engine's optimization decisions, so time ordinary pages separately.
function observeAllocations() {
  const MapConstructor = globalThis.Map;
  const withResolvers = Promise.withResolvers;
  const counts = { maps: 0, resolvers: 0 };
  globalThis.Map = new Proxy(MapConstructor, {
    construct(target, args, newTarget) {
      counts.maps++;
      return Reflect.construct(target, args, newTarget);
    },
  });
  Promise.withResolvers = function (...args) {
    counts.resolvers++;
    return Reflect.apply(withResolvers, this, args);
  };
  return {
    read: () => ({ ...counts }),
    restore() { globalThis.Map = MapConstructor; Promise.withResolvers = withResolvers; },
  };
}

// Sent to Chromium. The two entry URLs carry identical generated bytes. Only their external
// runtime specifiers resolve to the same URL, so the second import can reuse those modules.
async function measure({ demo, directories, name, args }, observe) {
  const { getMeasurements } = await import("/examples/" + demo + "/main.js");
  await import("/host/web-host.js");
  performance.setResourceTimingBufferSize(1000);
  const samples = [];
  for (const dir of directories) {
    document.body.replaceChildren();
    performance.clearMarks();
    performance.clearMeasures();
    performance.clearResourceTimings();
    const counter = observe?.();
    let start, ready, first, atImport, atResult;
    try {
      start = performance.now();
      const { run } = await import(dir + "/" + name + ".js");
      ready = performance.now();
      atImport = counter?.read();
      run(...args);
      first = performance.now();
      atResult = counter?.read();
    } finally {
      counter?.restore();
    }
    const reports = Object.values(getMeasurements());
    if (reports.length !== 1 || !Object.keys(reports[0]).length ||
        !Object.values(reports[0]).every(v => Number.isFinite(v) && v >= 0)) throw Error("Invalid guest result");
    const requests = performance.getEntriesByType("resource").map(entry => ({
      path: new URL(entry.name).pathname, bytes: entry.encodedBodySize, transferred: entry.transferSize,
    }));
    samples.push({ loadMs: ready - start, firstResultMs: first - start, requests, ...(counter ? { atImport, atResult } : {}) });
  }
  return samples;
}

let seed = 18671;
function shuffled(items) {
  const result = [...items];
  for (let i = result.length - 1; i; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = Math.floor(seed * (i + 1) / 4294967296);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
// Each treatment appears equally often in every position and after each other treatment.
const orders = [[0,1,3,2],[1,2,0,3],[2,3,1,0],[3,0,2,1]];
const blocks = new Map();
const samples = [];
let chromium;
for (let round = 0; round < rounds; round++) {
  const queue = [];
  for (const item of shuffled(cases)) {
    if (round % 4 === 0) blocks.set(item.base, { rows: shuffled(orders), labels: shuffled(variants) });
    const { rows, labels } = blocks.get(item.base);
    for (const index of rows[round % 4]) queue.push({ ...item, version: labels[index] });
  }
  let position = 0;
  const gate = Promise.withResolvers(), done = Promise.withResolvers();
  done.promise.catch(() => {});
  const watchdog = setTimeout(() => done.reject(Error("Timed out waiting for Chromium")), 90000);
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      if (path === "/") {
        res.setHeader("Content-Type", "text/html");
        return res.end('<script>fetch("/gate").then(() => location.replace("/trial/0"))</script>');
      }
      if (path === "/gate") { await gate.promise; return res.end(); }
      if (path === "/favicon.ico") return res.writeHead(204).end();
      const { base, name, demo, version } = queue[position];
      const directories = ["a", "b"].map(suffix => base + "/slot" + position + suffix);
      const resolveAsset = path => {
        for (const dir of directories) if (path.startsWith(dir + "/")) return base + "/" + version + path.slice(dir.length);
        return path;
      };
      if (path === "/trial/" + position) {
        res.setHeader("Content-Type", "text/html");
        const importMap = version === "shared" ? '<script type="importmap">' + JSON.stringify({ imports: shared.imports }) + '</script>' : "";
        return res.end(`<!doctype html><body>${importMap}<script type="module">
          let data;
          try { data = await (${measure})(${JSON.stringify({ demo, directories, name, args: workload[demo] })}, ${countAllocations ? observeAllocations : "undefined"}) }
          catch (e) { data = { error: String(e.stack || e) } }
          const next = await (await fetch("/result/${position}", {method:"POST",body:JSON.stringify(data)})).text();
          if (next) location.replace(next);
        </script></body>`);
      }
      if (path === "/result/" + position && req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const pair = JSON.parse(body);
        assert(Array.isArray(pair), JSON.stringify(pair));
        assert.equal(pair.length, 2);
        for (const [i, sample] of pair.entries()) {
          assert(sample.loadMs > 0 && sample.firstResultMs > sample.loadMs);
          const seen = new Set();
          for (const r of sample.requests) {
            const canonical = resolveAsset(r.path);
            assert(r.path.startsWith(directories[i] + "/") || r.path.startsWith("/runtime/"), r.path);
            assert(!seen.has(canonical) && r.transferred > 0);
            seen.add(canonical);
            assert.equal(r.bytes, manifest[canonical].bytes);
            r.path = canonical;
          }
          const generated = Object.keys(manifest).filter(path => path.startsWith(base + "/" + version + "/"));
          assert.deepEqual([...seen].filter(path => !path.startsWith("/runtime/")).sort(), generated.sort());
          assert.equal([...seen].some(path => path.startsWith("/runtime/")), (version === "external" || version === "shared") && i === 0);
        }
        samples.push({ round, position, base, version, pair });
        position++;
        watchdog.refresh();
        if (position === queue.length) { res.end(); done.resolve(); }
        else res.end("/trial/" + position);
        return;
      }
      const asset = assets.get(resolveAsset(path));
      assert(asset, "Unknown resource " + path);
      res.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : "application/wasm");
      res.end(asset);
    } catch (error) { res.writeHead(500).end(); done.reject(error); }
  });
  let browser, endpoint;
  try {
    await new Promise((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
    browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN,
      channel: process.env.CHROME_BIN ? undefined : "chrome", args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [] });
    chromium = await browser.version();
    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:" + server.address().port);
    endpoint = browser.wsEndpoint();
    await browser.disconnect();
    gate.resolve();
    await done.promise;
  } finally {
    clearTimeout(watchdog);
    gate.resolve();
    try {
      if (endpoint) browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
      await browser?.close();
    } finally { server.closeAllConnections(); server.close(); }
  }
  console.log("Completed provider startup round", round + 1);
}
const result = { revision, countAllocations, allExports: mode === "--all-exports", release: inventory.baseline, generatorSha256: hash(await readFile(generator)),
  runnerSha256: hash(await readFile(import.meta.filename)), chromium, cpu: cpus()[0].model, rounds, seed: 18671,
  workload, manifest, providerImports: shared.imports, providerExports: shared.exports,
  packerSha256: hash(await readFile(join(import.meta.dirname, "shared-provider.mjs"))), samples };
await writeFile(output, gzipSync(JSON.stringify(result), { level: 9 }));
