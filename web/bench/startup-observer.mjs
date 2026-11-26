// A fresh document times its own import and sends the result over HTTP. Holding
// its first navigation at the server lets the DevTools client disconnect before
// any measured module loads. Both modes use the same documents and Chrome flags.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { cpus } from "node:os";
import { basename, join } from "node:path";
import puppeteer from "puppeteer-core";

const bench = import.meta.dirname;
const web = join(bench, "..");
const results = join(bench, "results");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const original = await readFile(join(results, "minified-browser.json"));
const trial = JSON.parse(original);
const full = await readFile(join(results, "candidate-sizes.json"));
const min = await readFile(join(results, "minified-sizes.json"));
assert.equal(hash(full), trial.sizesSha256);
assert.equal(hash(min), trial.minifiedSizesSha256);
const mode = process.argv.slice(2).join(" ");
assert(["", "--compile-hint", "--compile-hint --small"].includes(mode), "Expected --compile-hint [--small] or no options");
const compareHint = mode !== "";
const small = mode.endsWith("--small");
// These five guests accept fixed operation counts. The other two adapt their loop count to elapsed time.
const workloads = small ? {
  "attribute-churn": { elements: 8, iters: 2 },
  "canvas-draw": { rects: 16 },
  "dom-query": { numElements: 8, iters: 2 },
  "dom-traversal": { depth: 2, numChildren: 2 },
  "table-update": { rows: 8 },
} : trial.workloads;
const hint = Buffer.from("//# allFunctionsCalledOnLoad\n");
const rounds = Number(process.env.ROUNDS ?? 5);
assert(Number.isInteger(rounds) && rounds > 0);

const assets = new Map();
for (const [path, digest] of Object.entries(trial.sources)) {
  assert.equal(hash(await readFile(join(web, path))), digest, path);
  if (!path.startsWith("bench/")) assets.set("/" + path, "text/javascript");
}
const minified = JSON.parse(min).components;
const inventory = JSON.parse(full);
const builds = [];
const hintedSources = {};
for (const { input, variants } of inventory.components) {
  const [lang, demo] = input.path.split("/");
  if (!Object.hasOwn(workloads, demo) || basename(input.path) !== demo.replaceAll("-", "_") + ".wasm") continue;
  for (const [version, files] of Object.entries({ ...variants, ...minified[input.path] })) {
    if (compareHint && !["baseline", "main", "candidate"].includes(version)) continue;
    const paths = {};
    for (const file of files) {
      const path = "/" + file.path;
      assert.equal(hash(await readFile(join(web, file.path))), file.sha256, path);
      assets.set(path, path.endsWith(".js") ? "text/javascript" : "application/wasm");
      paths[path] = file.bytes;
    }
    const scripts = Object.keys(paths).filter(path => path.endsWith(".js"));
    assert.equal(scripts.length, 1);
    builds.push({ lang, demo, version, path: scripts[0], paths });
    if (compareHint) {
      const path = scripts[0];
      const source = await readFile(join(web, path));
      hintedSources[path] = hash(Buffer.concat([hint, source]));
      builds.push({ lang, demo, version: version + "-eager", path,
        paths: { ...paths, [path]: paths[path] + hint.length } });
    }
  }
}
assert.equal(builds.length, Object.keys(workloads).length * 3 * (!compareHint && inventory.reference ? 7 : 6));

// Stringified into a module script in the trial document.
async function measure({ demo, path, args }) {
  const { getMeasurements } = await import("/examples/" + demo + "/main.js");
  const start = performance.now();
  const { run } = await import(path);
  const ready = performance.now();
  run(...args);
  const complete = performance.now();
  const directory = path.slice(0, path.lastIndexOf("/") + 1);
  const requests = performance.getEntriesByType("resource").flatMap(entry => {
    const path = new URL(entry.name).pathname;
    if (!path.startsWith(directory)) return [];
    return [{ path, bytes: entry.encodedBodySize, transferred: entry.transferSize,
      startMs: entry.startTime - start, endMs: entry.responseEnd - start }];
  });
  const reports = Object.values(getMeasurements());
  if (reports.length !== 1 || !Object.keys(reports[0]).length ||
      !Object.values(reports[0]).every(v => Number.isFinite(v) && v >= 0)) throw Error("Invalid guest result");
  return { loadMs: ready - start, firstCallMs: complete - ready, firstResultMs: complete - start, requests };
}

const samples = [];
let browserVersion;
async function runBlock(order, round, attached) {
  const gate = Promise.withResolvers();
  const done = Promise.withResolvers();
  // The server and Chrome can fail before the page has reached the gate.
  done.promise.catch(() => {});
  let position = 0;
  const watchdog = setTimeout(() => done.reject(Error("Timed out waiting for startup trial")), 60_000);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      if (url.pathname === "/") {
        res.setHeader("Content-Type", "text/html");
        return res.end('<!doctype html><script>fetch("/go").then(() => location.replace("/trial/0"))</script>');
      }
      if (url.pathname === "/go") {
        await gate.promise;
        return res.end("go");
      }
      if (assets.has(url.pathname)) {
        res.setHeader("Content-Type", assets.get(url.pathname));
        const bytes = await readFile(join(web, url.pathname));
        if (url.search === "?eager") {
          assert(compareHint && Object.hasOwn(hintedSources, url.pathname));
          return res.end(Buffer.concat([hint, bytes]));
        }
        return res.end(bytes);
      }
      if (url.pathname === "/favicon.ico") return res.writeHead(204).end();
      const build = order[position];
      if (req.method === "GET" && url.pathname === "/trial/" + position) {
        const path = build.path + (build.version.endsWith("-eager") ? "?eager" : "");
        const params = JSON.stringify({ demo: build.demo, path, args: Object.values(workloads[build.demo]) });
        res.setHeader("Content-Type", "text/html");
        return res.end(`<!doctype html><body><script type="module">
          let result;
          try { result = await (${measure})(${params}) }
          catch (err) { result = {error: String(err?.stack ?? err)} }
          const next = await (await fetch("/result/${position}", {method:"POST", body:JSON.stringify(result)})).text();
          if (next) location.replace(next);
        </script></body>`);
      }
      if (req.method === "POST" && url.pathname === "/result/" + position) {
        let body = "";
        for await (const chunk of req) body += chunk;
        const { error, loadMs, firstCallMs, firstResultMs, requests } = JSON.parse(body);
        assert(!error, error);
        assert(Number.isFinite(loadMs) && loadMs > 0);
        assert(Number.isFinite(firstCallMs) && firstCallMs > 0);
        assert(Math.abs(firstResultMs - loadMs - firstCallMs) < 0.001);
        const names = requests.map(r => r.path);
        assert.deepEqual(names.toSorted(), Object.keys(build.paths).sort());
        for (const r of requests) {
          assert.equal(r.bytes, build.paths[r.path], r.path);
          assert(r.transferred > 0 && r.startMs >= 0 && r.endMs >= r.startMs && r.endMs <= loadMs + .01);
        }
        const script = requests.find(r => r.path === build.path);
        const wasm = requests.filter(r => r.path.endsWith(".wasm"));
        const wasmStartMs = Math.min(...wasm.map(r => r.startMs));
        const wasmEndMs = Math.max(...wasm.map(r => r.endMs));
        assert(wasm.length > 0 && wasmStartMs >= script.endMs - .01);
        samples.push({ round, attached, demo: build.demo, lang: build.lang, version: build.version,
          loadMs, firstCallMs, firstResultMs, jsEndMs: script.endMs, wasmStartMs, wasmEndMs });
        position++;
        watchdog.refresh();
        if (position === order.length) {
          res.end();
          done.resolve();
        } else res.end("/trial/" + position);
        return;
      }
      res.writeHead(404).end();
    } catch (err) {
      res.writeHead(500).end();
      done.reject(err);
    }
  });
  let browser;
  let disconnected = false;
  let endpoint;
  try {
    await new Promise((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
    browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN,
      channel: process.env.CHROME_BIN ? undefined : "chrome", headless: true,
      args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [] });
    const version = await browser.version();
    if (browserVersion) assert.equal(version, browserVersion);
    browserVersion = version;
    endpoint = browser.wsEndpoint();
    browser.process().once("exit", () => done.reject(Error("Chrome exited during startup trial")));
    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:" + server.address().port);
    if (!attached) {
      await browser.disconnect();
      disconnected = true;
    }
    gate.resolve();
    await done.promise;
  } finally {
    clearTimeout(watchdog);
    gate.resolve();
    try {
      if (disconnected) browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
      await browser?.close();
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }
}

for (let n = 0; n < rounds; n++) {
  const order = builds.map((_, i) => builds[(n + (n % 2 ? -i : i) + builds.length) % builds.length]);
  const modes = compareHint ? [false] : n % 2 ? [true, false] : [false, true];
  for (const attached of modes) {
    await runBlock(order, n + 1, attached);
    console.log(`Round ${n + 1}/${rounds} · ${attached ? "attached" : "detached"} · ${order.length} documents`);
  }
}
const filename = small ? "compile-hint-small.json" : compareHint ? "compile-hint.json" : "startup-observer.json";
await writeFile(join(results, filename), JSON.stringify({
  date: new Date().toISOString(), browser: browserVersion, cpu: cpus()[0].model, node: process.version, rounds,
  originalSha256: hash(original), runnerSha256: hash(await readFile(import.meta.filename)),
  ...(compareHint ? { hint: hint.toString(), hintedSources, workloads } : {}), samples,
}, null, 2) + "\n");
