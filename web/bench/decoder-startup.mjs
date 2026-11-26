// Compare a packaged provider change in fresh same-origin documents with DevTools detached.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import puppeteer from "puppeteer-core";

const [before, oldBin, after, newBin, output] = process.argv.slice(2);
assert(output, "Usage: decoder-startup.mjs <before-checkout> <before-transpile> <after-checkout> <after-transpile> <output.json.gz>");
const bench = import.meta.dirname, web = join(bench, "..");
const rounds = Number(process.env.ROUNDS ?? 16);
assert(Number.isInteger(rounds) && rounds > 0 && rounds % 4 === 0);
const hash = b => createHash("sha256").update(b).digest("hex");
const inventory = JSON.parse(await readFile(join(bench, "results/candidate-sizes.json")));
const flags = (await readFile(join(web, "host/imports.txt"), "utf8")).trim().split("\n").map(line => {
  const [name, symbol] = line.split(/\s+/);
  return "--map=" + name + "=../../../host/web-host.js#" + symbol;
});
const inputs = { "dom-query": [8, 2], "table-update": [8] };
const assets = new Map(), manifest = {}, builds = {};
function register(path, b) {
  assets.set(path, b);
  manifest[path] = { bytes: b.length, sha256: hash(b) };
}
for (const file of ["host/web-host.js", "host/common.js", ...Object.keys(inputs).map(d => "examples/" + d + "/main.js")]) {
  register("/" + file, await readFile(join(web, file)));
}
for (const [version, dir, bin] of [["before", before, oldBin], ["after", after, newBin]]) {
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
  builds[version] = { revision: git("rev-parse", "HEAD"), generatorSha256: hash(await readFile(bin)) };
  const runtime = join(dir, "packages/jco-cm-runtime/dist");
  for (const f of await readdir(runtime, { recursive: true })) {
    if (f.endsWith(".js") && !f.startsWith("debug/")) register("/" + version + "/runtime/" + f, await readFile(join(runtime, f)));
  }
}
const modes = ["before", "after", "bundled", "release"], cases = [];
const tmp = await mkdtemp(join(tmpdir(), "decoder-startup-"));
try {
  for (const { input, variants } of inventory.components) {
    const [lang, demo] = input.path.split("/"), name = basename(input.path, ".wasm");
    if (!Object.hasOwn(inputs, demo) || name !== demo.replaceAll("-", "_")) continue;
    const base = "/" + lang + "/" + demo, guest = join(web, input.path);
    assert.equal(hash(await readFile(guest)), input.sha256);
    const cores = {};
    for (const version of modes) {
      let files;
      if (version === "release") {
        files = await Promise.all(variants.baseline.map(async f => {
          const b = await readFile(join(web, f.path)); assert.equal(hash(b), f.sha256);
          return [basename(f.path), b];
        }));
      } else {
        const dir = join(tmp, lang, demo, version);
        const external = version === "bundled" ? [] : ["--runtime=/runtime", "--cm-runtime-sync-imports"];
        execFileSync(resolve(version === "before" ? oldBin : newBin), [guest, dir, "--name=" + name,
          "--no-nodejs-compat", "--base64-cutoff=5000", "--namespaced-exports", ...external, ...flags]);
        files = await Promise.all((await readdir(dir)).map(async f => [f, await readFile(join(dir, f))]));
      }
      const hashes = {};
      for (const [f, b] of files) {
        if (f.endsWith(".wasm")) hashes[f] = hash(b);
        register(base + "/" + version + "/" + f, b);
      }
      if (version === modes[0]) Object.assign(cores, hashes);
      else assert.deepEqual(hashes, cores);
    }
    cases.push({ base, demo, name });
  }
} finally { await rm(tmp, { recursive: true, force: true }); }
assert.equal(cases.length, 6);
async function measure({ demo, entry, args }) {
  const { getMeasurements } = await import("/examples/" + demo + "/main.js");
  performance.clearResourceTimings();
  const start = performance.now();
  const { run } = await import(entry);
  const ready = performance.now();
  run(...args);
  const end = performance.now();
  const reports = Object.values(getMeasurements());
  if (reports.length !== 1 || !Object.keys(reports[0]).length || !Object.values(reports[0]).every(n => Number.isFinite(n) && n >= 0)) throw Error("Invalid guest result");
  return { loadMs: ready - start, firstResultMs: end - start, requests: performance.getEntriesByType("resource").map(r =>
    ({ path: new URL(r.name).pathname, bytes: r.encodedBodySize, transferred: r.transferSize })) };
}
let seed = 922427;
function shuffled(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = Math.floor(seed / 4294967296 * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
const sequences = [[0,1,3,2],[1,2,0,3],[2,3,1,0],[3,0,2,1]];
const samples = [], blocks = new Map();
let chromium;
for (let round = 0; round < rounds; round++) {
  const queue = [];
  for (const item of shuffled(cases)) {
    if (round % 4 === 0) blocks.set(item.base, { labels: shuffled(modes), rows: shuffled(sequences) });
    const { labels, rows } = blocks.get(item.base);
    for (const i of rows[round % 4]) queue.push({ ...item, version: labels[i] });
  }
  const gate = Promise.withResolvers(), done = Promise.withResolvers();
  done.promise.catch(() => {});
  let position = 0;
  const watchdog = setTimeout(() => done.reject(Error("Timed out at " + position)), 60000);
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      if (path === "/") { res.setHeader("Content-Type", "text/html"); return res.end('<script>fetch("/gate").then(()=>location.replace("/trial/0"))</script>'); }
      if (path === "/gate") { await gate.promise; return res.end(); }
      if (path === "/favicon.ico") return res.writeHead(204).end();
      const { demo, base, version, name } = queue[position];
      const dir = base + "/slot" + position;
      const canonical = path => path.startsWith("/runtime/") ? "/" + version + path :
        path.startsWith(dir + "/") ? base + "/" + version + path.slice(dir.length) : path;
      if (path === "/trial/" + position) {
        const args = { demo, entry: dir + "/" + name + ".js", args: inputs[demo] };
        res.setHeader("Content-Type", "text/html");
        return res.end(`<!doctype html><body><script type="module">let r;try{r=await (${measure})(${JSON.stringify(args)})}catch(e){r={error:String(e.stack||e)}}
          const next=await(await fetch("/result/${position}",{method:"POST",body:JSON.stringify(r)})).text();if(next)location.replace(next);</script>`);
      }
      if (path === "/result/" + position && req.method === "POST") {
        let body = ""; for await (const chunk of req) body += chunk;
        const data = JSON.parse(body);
        assert(!data.error, data.error);
        assert(data.loadMs > 0 && data.firstResultMs > data.loadMs);
        const seen = new Set();
        for (const r of data.requests) {
          r.path = canonical(r.path);
          assert.equal(manifest[r.path].bytes, r.bytes);
          assert(r.transferred > 0 && !seen.has(r.path));
          seen.add(r.path);
        }
        assert(seen.has(base + "/" + version + "/" + name + ".js"));
        assert.equal(seen.has("/" + version + "/runtime/intrinsics/lift.js"), version === "before");
        samples.push({ round, position, base, version, ...data });
        position++; watchdog.refresh();
        if (position === queue.length) { res.end(); done.resolve(); }
        else res.end("/trial/" + position);
        return;
      }
      const bytes = assets.get(canonical(path));
      assert(bytes, path);
      res.setHeader("Content-Type", path.endsWith(".wasm") ? "application/wasm" : "text/javascript");
      res.end(bytes);
    } catch (e) { res.writeHead(500).end(); done.reject(e); }
  });
  let browser, endpoint;
  try {
    await new Promise((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
    browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN, channel: process.env.CHROME_BIN ? undefined : "chrome",
      args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [] });
    chromium = await browser.version();
    await (await browser.newPage()).goto("http://127.0.0.1:" + server.address().port);
    endpoint = browser.wsEndpoint();
    await browser.disconnect(); gate.resolve(); await done.promise;
  } finally {
    clearTimeout(watchdog); gate.resolve();
    try { if (endpoint) browser = await puppeteer.connect({ browserWSEndpoint: endpoint }); await browser?.close(); }
    finally { server.closeAllConnections(); server.close(); }
  }
  console.log("Completed external decoder round", round + 1, "of", rounds);
}
await writeFile(output,gzipSync(JSON.stringify({ builds,release:inventory.baseline,inputs,rounds,chromium,cpu:cpus()[0].model,
  runnerSha256:hash(await readFile(import.meta.filename)),manifest,samples })));
