// Measure the cost of repeatedly resolving a resource table's handle allocator.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import puppeteer from "puppeteer-core";

const [checkout, manifest, output] = process.argv.slice(2);
assert(output, "Usage: table-handle-space.mjs <built Jco> <matrix.json.gz> <result.json.gz>");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const matrixBytes = await readFile(manifest);
const matrix = JSON.parse(gunzipSync(matrixBytes));
const web = join(import.meta.dirname, "..");
const { transpileBytes } = await import(pathToFileURL(resolve(checkout, "packages/jco-transpile/dist/transpile.js")));
const versions = ["release", "bundled", "external"];
const treatments = ["release", "bundled", "bundled-cache", "external", "external-cache"];
const cases = matrix.samples.filter(r => r.round === 0 && r.lang === "c" && r.demo === "table-update" && versions.includes(r.version));
assert.equal(cases.length, 3);
const rows = matrix.workloads["table-update"].rows;
const component = await readFile(join(web, "c/table-update/native/table_update.wasm"));
const map = Object.fromEntries((await readFile(join(web, "host/imports.txt"), "utf8")).trim().split("\n").map(line => {
  const [key, name] = line.split(/\s+/);
  return [key, "../../../host/web-host.js#" + name];
}));
const assets = new Map(), imports = {}, patches = {}, expected = {}, entries = {};
function add(path, bytes) {
  assert.equal(hash(bytes), matrix.manifest[path].sha256, path);
  assets.set(path, Buffer.from(bytes));
}
for (const path of ["/host/common.js", "/host/web-host.js", "/examples/table-update/main.js"])
  add(path, await readFile(join(web, path)));
for (const { version, entry, requests } of cases) {
  const files = version === "release" ? null : (await transpileBytes(component, {
    name: "table_update", minify: true, map, base64Cutoff: 5000, emitTypescriptDeclarations: false,
    nodejsCompat: false, namespacedExports: true,
    ...(version === "external" && {cmRuntimeEsModule: matrix.checkedPackage}),
  })).files;
  entries[version] = entry;
  expected[version] = requests.map(r => r.path).sort();
  for (const { path } of requests) {
    if (path.startsWith("/runtime/")) {
      const file = path.slice(9);
      add(path, await readFile(join(checkout, "packages/jco-cm-runtime/dist", file)));
      imports[matrix.checkedPackage + "/" + file.slice(0, -3)] = path;
    } else {
      add(path, files ? files[basename(path)] : await readFile(join(web, "c/table-update/jco-baseline-minified", basename(path))));
    }
  }
}

// In this single-instance fixture each table always uses one stable index-space map
// and component index. Memoize on the table for this experiment only. Each timed
// replacement leaves the original allocator and free-list semantics intact.
const variants = new Map();
for (const version of ["bundled", "external"]) {
  let siteCount = 0;
  const paths = version === "bundled" ? [entries.bundled] : expected.external.filter(p => p.startsWith("/runtime/"));
  for (const path of paths) {
    const original = assets.get(path).toString();
    const pattern = /([\w$]+\([\w$.]+,([\w$]+)\._componentIdx\?\?\2\))(?=\.(?:alloc|release)\()/g;
    const sites = [...original.matchAll(pattern)];
    if (!sites.length) continue;
    assert(!original.includes(".__benchSpace"));
    siteCount += sites.length;
    const replacements = {};
    for (const cached of [false, true]) {
      for (const audit of [false, true]) {
        const key = [cached, audit].join("-");
        const js = original.replace(pattern, (expression, _, table) => {
          const lookup = audit ? "(++globalThis.spaceLookups," + expression + ")" : expression;
          return cached ? "(" + table + ".__benchSpace??=" + lookup + ")" : lookup;
        });
        replacements[key] = Buffer.from(js);
      }
    }
    variants.set(path, replacements);
    patches[path] = { original: hash(assets.get(path)), cached: hash(replacements["true-false"]), sites: sites.length };
  }
  assert.equal(siteCount, version === "bundled" ? 2 : 3);
}

async function measure({ entry, rows, audit }) {
  await import("/host/web-host.js");
  const { getMeasurements } = await import("/examples/table-update/main.js");
  performance.clearResourceTimings();
  globalThis.spaceLookups = 0;
  const started = performance.now();
  const { run } = await import(entry);
  const importMs = performance.now() - started;
  const observations = [];
  const mark = performance.mark;
  if (audit) performance.mark = function(name, ...args) {
    if (name === "create-start" || name === "create-end") {
      if (name === "create-end") {
        const body = document.querySelector("details tbody");
        if (body.children.length !== rows || body.firstElementChild.textContent !== "row 1" ||
            body.lastElementChild.textContent !== "row " + rows) throw Error("Incorrect live rows");
      }
      observations.push({ name, lookups: globalThis.spaceLookups });
    }
    return mark.call(this, name, ...args);
  };
  const calls = [];
  for (let i = 0; i < (audit ? 2 : 8); i++) {
    document.body.replaceChildren();
    performance.clearMarks();
    performance.clearMeasures();
    const start = performance.now();
    run(rows);
    const guestMs = performance.now() - start;
    const [report] = Object.values(getMeasurements());
    if (Object.keys(report).length !== 6 || !Object.values(report).every(n => Number.isFinite(n) && n > 0))
      throw Error("Invalid guest timings");
    calls.push({ guestMs, createMs: report["create: total ms"] * 1000 });
  }
  const requests = performance.getEntriesByType("resource").map(r => new URL(r.name).pathname).sort();
  return { importMs, calls, requests, observations, lookups: globalThis.spaceLookups };
}

let cached = false, audit = false, browser;
const html = '<!doctype html><script type="importmap">' + JSON.stringify({ imports }) + '</script>';
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  if (path === "/") return res.writeHead(200, {"Content-Type": "text/html"}).end(html);
  if (!assets.has(path)) return res.writeHead(404).end();
  res.writeHead(200, {"Content-Type": path.endsWith(".wasm") ? "application/wasm" : "text/javascript"});
  res.end(variants.get(path)?.[[cached, audit].join("-")] ?? assets.get(path));
});
const samples = [], audits = [];
try {
  await new Promise((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN, pipe: true,
    args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [] });
  const url = "http://127.0.0.1:" + server.address().port;
  for (let round = -1; round < 20; round++) {
    audit = round === -1;
    const order = [0, 1, 4, 2, 3];
    if (round >= 0 && Math.floor(round / 5) % 2) order.reverse();
    for (const [position, index] of order.entries()) {
      const treatment = treatments[(index + Math.max(round, 0)) % 5];
      cached = treatment.endsWith("-cache");
      const version = treatment.split("-")[0];
      const context = await browser.createBrowserContext();
      try {
        const page = await context.newPage();
        await page.goto(url);
        const result = await page.evaluate(measure, { entry: entries[version], rows, audit });
        assert.deepEqual(result.requests, expected[version]);
        if (audit) assert.equal(result.observations.length, 4);
        (audit ? audits : samples).push({ round, position, treatment, ...result });
      } finally { await context.close(); }
    }
  }
  await writeFile(output, gzipSync(JSON.stringify({ matrix: hash(matrixBytes), runner: hash(await readFile(import.meta.filename)),
    browser: await browser.version(), rows, patches, audits, samples })));
} finally { await browser?.close(); server.closeAllConnections(); server.close(); }
