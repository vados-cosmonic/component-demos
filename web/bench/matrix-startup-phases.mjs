// Split one cold module import at browser-observed JS and Wasm response boundaries.
// V8 coverage gets separate documents because it changes how scripts are compiled.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import puppeteer from "puppeteer-core";

const [checkout, matrixPath, lang, demo, output] = process.argv.slice(2);
assert(output, "Usage: matrix-startup-phases.mjs <built Jco> <matrix.gz> <language> <demo> <result.gz>");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const matrixBytes = await readFile(matrixPath), matrix = JSON.parse(gunzipSync(matrixBytes));
const web = join(import.meta.dirname, ".."), name = demo.replaceAll("-", "_");
const versions = ["release", "bundled", "external"];
const map = Object.fromEntries((await readFile(join(web, "host/imports.txt"), "utf8")).trim().split("\n").map(line => {
  const [id, symbol] = line.split(/\s+/);
  return [id, "../../../host/web-host.js#" + symbol];
}));
const { transpileBytes } = await import(pathToFileURL(resolve(checkout, "packages/jco-transpile/dist/transpile.js")));
const input = await readFile(join(web, lang, demo, "native", name + ".wasm"));
const assets = new Map(), expected = {}, entries = {}, imports = {};
function add(path, bytes) {
  assert.equal(digest(bytes), matrix.manifest[path].sha256, path);
  assets.set(path, Buffer.from(bytes));
}
for (const path of ["/host/common.js", "/host/web-host.js", "/examples/" + demo + "/main.js"])
  add(path, await readFile(join(web, path)));
for (const version of versions) {
  const { entry, requests } = matrix.samples.find(s => s.round === 0 && s.version === version && s.lang === lang && s.demo === demo);
  entries[version] = entry;
  expected[version] = requests.map(r => r.path).sort();
  assert.equal(requests.filter(r => r.path.endsWith(".wasm")).length, 1, "requires one separately served core");
  const files = version === "release" ? null : (await transpileBytes(input, {
    name, minify: true, base64Cutoff: 5000, namespacedExports: true, emitTypescriptDeclarations: false,
    nodejsCompat: false, map, ...(version === "external" && { cmRuntimeEsModule: matrix.checkedPackage }),
  })).files;
  for (const { path } of requests) {
    if (path.startsWith("/runtime/")) {
      const file = path.slice(9);
      add(path, await readFile(join(checkout, "packages/jco-cm-runtime/dist", file)));
      imports[matrix.checkedPackage + "/" + file.slice(0,-3)] = path;
    } else {
      add(path, files ? files[basename(path)] : await readFile(join(web, lang, demo, "jco-baseline-minified", basename(path))));
    }
  }
}

async function measure({ demo, entry, args, runGuest }) {
  const { getMeasurements } = await import("/examples/" + demo + "/main.js");
  await import("/host/web-host.js");
  performance.clearResourceTimings();
  const start = performance.now();
  const guest = await import(entry);
  const ready = performance.now() - start;
  let firstResult;
  if (runGuest) {
    guest.run(...args);
    firstResult = performance.now() - start;
    const reports = Object.values(getMeasurements());
    if (reports.length !== 1 || Object.keys(reports[0]).length === 0 ||
        !Object.values(reports[0]).every(v => Number.isFinite(v) && v >= 0)) throw Error("Invalid guest report");
  }
  const requests = performance.getEntriesByType("resource").map(r => ({
    path: new URL(r.name).pathname, start: r.startTime - start, end: r.responseEnd - start,
    bytes: r.encodedBodySize, transferred: r.transferSize,
  }));
  return { ready, firstResult, requests };
}
const html = '<!doctype html><script type="importmap">' + JSON.stringify({ imports }) + '</script>';
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  if (path === "/") return res.writeHead(200, {"Content-Type": "text/html"}).end(html);
  if (!assets.has(path)) return res.writeHead(404).end();
  res.writeHead(200, {"Content-Type": path.endsWith(".wasm") ? "application/wasm" : "text/javascript"}).end(assets.get(path));
});
let browser;
const samples = [], coverage = [];
try {
  await new Promise((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN, pipe: true,
    args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [] });
  const url = "http://127.0.0.1:" + server.address().port;
  async function collect(version, observe, runGuest) {
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      await page.goto(url);
      if (observe) await page.coverage.startJSCoverage({ useBlockCoverage: true });
      const result = await page.evaluate(measure, { demo, entry: entries[version],
        args: Object.values(matrix.workloads[demo]), runGuest });
      assert.deepEqual(result.requests.map(r => r.path).sort(), expected[version]);
      for (const r of result.requests) {
        assert.equal(r.bytes, assets.get(r.path).length, r.path);
        assert(r.transferred > 0 && r.end >= r.start && r.end <= result.ready);
      }
      if (observe) {
        const scripts = [];
        for (const s of await page.coverage.stopJSCoverage()) {
          const path = new URL(s.url).pathname;
          if (!expected[version].includes(path)) continue;
          const bytes = Buffer.byteLength(s.text);
          assert.equal(digest(s.text), matrix.manifest[path].sha256);
          const reached = s.ranges.reduce((n, r) => n + Buffer.byteLength(s.text.slice(r.start, r.end)), 0);
          assert(reached <= bytes);
          scripts.push({ path, bytes, reached });
        }
        assert.deepEqual(scripts.map(s => s.path).sort(), expected[version].filter(p => p.endsWith(".js")));
        coverage.push({ version, runGuest, scripts });
      }
      return result;
    } finally { await context.close(); }
  }
  for (const version of versions)
    for (const runGuest of [false, true]) await collect(version, true, runGuest);
  for (let round = 0; round < 18; round++) {
    const order = Math.floor(round / 3) % 2 ? [2, 1, 0] : [0, 1, 2];
    for (const [position, index] of order.entries()) {
      const version = versions[(round + index) % 3];
      samples.push({ round, position, version, ...await collect(version, false, true) });
    }
  }
  await writeFile(output, gzipSync(JSON.stringify({ candidate: matrix.candidate, matrix: digest(matrixBytes),
    runner: digest(await readFile(import.meta.filename)), browser: await browser.version(), lang, demo, entries, samples, coverage })));
} finally { await browser?.close(); server.closeAllConnections(); server.close(); }
