// Compare the same guest's bulk query and handle disposal across the checked adapters and direct host.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import puppeteer from "puppeteer-core";

const [checkout, output, option, matrixFile, ...extra] = process.argv.slice(2);
const checked = option === "--checked-matrix";
assert(checkout && output && !extra.length && checked === Boolean(matrixFile),
  "Usage: bulk-dom.mjs <built Jco> <output.gz> [prior built checkout | --checked-matrix matrix.gz]");
const before = checked ? undefined : option;
const bench = import.meta.dirname, web = join(bench, "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
const revision = git("rev-parse", "HEAD");
const matrixBytes = checked && await readFile(matrixFile);
const matrix = checked && JSON.parse(gunzipSync(matrixBytes));
if (checked) assert.equal(matrix.candidate, revision);
const inventory = JSON.parse(await readFile(join(bench, "results/candidate-sizes.json")));
const {transpileBytes} = await import(pathToFileURL(resolve(checkout, "packages/jco-transpile/dist/transpile.js")));
const prior = before && await import(pathToFileURL(resolve(before, "packages/jco-transpile/dist/transpile.js")));
const compilerHash = async dir => hash(await readFile(resolve(dir,
  "packages/jco-transpile/vendor/js-component-bindgen-component.core.wasm")));
const compilers = {candidate: await compilerHash(checkout)};
if (before) compilers.before = await compilerHash(before);
const assets = new Map(), manifest = {};
function add(path, bytes) {
  assets.set(path, Buffer.from(bytes));
  manifest[path] = hash(bytes);
}
const runtime = resolve(checkout, "packages/jco-cm-runtime/dist");
for (const f of await readdir(runtime, {recursive: true})) {
  if (f.endsWith(".js") && !f.startsWith("debug/")) add("/runtime/" + f, await readFile(join(runtime, f)));
}
for (const f of ["host/web-host.js", "host/common.js", "bench/dom-core-shim.mjs", "examples/dom-query/main.js"]) {
  add("/" + f, await readFile(join(web, f)));
}
const imports = Object.fromEntries((await readFile(join(web, "host/imports.txt"), "utf8")).trim().split("\n").map(line => {
  const [n, s] = line.split(/\s+/);
  return [n, "../../../host/web-host.js#" + s];
}));
const languages = ["c", "cpp", "rust"];
const modes = ["direct", "release", "bundled", "external"];
if (before) modes.push("priorBundled", "priorExternal");
for (const lang of languages) {
  const path = lang + "/dom-query/native/dom_query.wasm", base = "/" + lang + "/dom-query/";
  const c = inventory.components.find(c => c.input.path === path);
  const guest = await readFile(join(web, path));
  assert.equal(hash(guest), c.input.sha256);
  manifest[path] = c.input.sha256;
  const coreHashes = {};
  const releaseFiles = checked
    ? matrix.samples.find(s => s.lang === lang && s.demo === "dom-query" && s.version === "release").requests
        .map(({path}) => ({path: join(lang, "dom-query/jco-baseline-minified", basename(path)), sha256: matrix.manifest[path].sha256}))
    : c.variants.baseline;
  for (const f of releaseFiles) {
    const bytes = await readFile(join(web, f.path));
    assert.equal(hash(bytes), f.sha256);
    if (f.path.endsWith(".wasm")) coreHashes[basename(f.path)] = f.sha256;
    add(base + "release/" + basename(f.path), bytes);
  }
  for (const mode of ["bundled", "external"]) {
    const opts = {name: "dom_query", nodejsCompat: false, base64Cutoff: 5000, namespacedExports: true,
      emitTypescriptDeclarations: false, minify: checked, map: {...imports}};
    if (mode === "external") Object.assign(opts, checked
      ? {cmRuntimeEsModule: matrix.checkedPackage} : {cmRuntimeEsModule: "/runtime", cmRuntimeSyncImports: true});
    const {files} = await transpileBytes(guest, opts);
    const cores = {};
    for (const [f, bytes] of Object.entries(files)) {
      if (f.endsWith(".wasm")) cores[f] = hash(bytes);
      add(base + mode + "/" + f, bytes);
    }
    assert.deepEqual(cores, coreHashes);
    if (prior) {
      const tag = mode === "external" ? "priorExternal" : "priorBundled";
      const original = (await prior.transpileBytes(guest, opts)).files;
      assert.deepEqual(Object.keys(original).sort(), Object.keys(files).sort());
      for (const [f, bytes] of Object.entries(original)) {
        if (f === "dom_query.js") {
          const source = new TextDecoder().decode(bytes);
          const bound = /i < vec(\d+)\.length/g;
          assert.equal([...source.matchAll(bound)].length, 1, "expected one compound list lower");
          assert.equal(source.replace(bound, "i < len$1"), new TextDecoder().decode(files[f]));
        } else assert.deepEqual(bytes, files[f]);
        add(base + tag + "/" + f, bytes);
      }
    }
  }
}
let documentHtml = "<!doctype html><body>";
if (checked) {
  const runtimeImports = {};
  for (const s of matrix.samples.filter(s => s.round === 0 && s.demo === "dom-query" && modes.includes(s.version))) {
    for (const {path} of s.requests) {
      assert.equal(manifest[path], matrix.manifest[path].sha256, path);
      if (path.startsWith("/runtime/") && !path.startsWith("/runtime/chunks/")) {
        runtimeImports[matrix.checkedPackage + "/" + path.slice("/runtime/".length, -3)] = path;
      }
    }
  }
  documentHtml = '<!doctype html><script type="importmap">' + JSON.stringify({imports: runtimeImports}) + '</script><body>';
}
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  if (path === "/") return res.writeHead(200, {"Content-Type": "text/html"}).end(documentHtml);
  if (!assets.has(path)) return res.writeHead(404).end();
  res.writeHead(200, {"Content-Type": path.endsWith(".wasm") ? "application/wasm" : "text/javascript"}).end(assets.get(path));
});
const sizes = checked ? [2000] : [25, 250, 2000], total = 20000;
const rounds = Number(process.env.ROUNDS ?? 12);
assert(Number.isInteger(rounds) && rounds >= 8 && rounds % modes.length === 0);
// Each build occupies every timing position and follows every other build once.
const first = before ? [0, 1, 5, 2, 4, 3] : [0, 1, 3, 2];
const orders = modes.map((_, r) => first.map(i => (i + r) % modes.length));
let browser;
try {
  await new Promise((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
  browser = await puppeteer.launch({executablePath: process.env.CHROME_BIN, channel: process.env.CHROME_BIN ? undefined : "chrome",
    args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []});
  const samples = [], checks = [];
  for (let round = 0; round < rounds; round++) {
    const cases = languages.flatMap(lang => sizes.map(size => ({lang, size})));
    for (let i = 0; i < cases.length; i++) {
      const {lang, size} = cases[(round + (round % 2 ? cases.length - i : i)) % cases.length];
      const page = await browser.newPage();
      try {
        await page.goto("http://127.0.0.1:" + server.address().port);
        const data = await page.evaluate(async ({lang, size, total, modes, orders, round}) => {
          const {getMeasurements} = await import("/examples/dom-query/main.js");
          const {instantiateDomGuest} = await import("/bench/dom-core-shim.mjs");
          const base = "/" + lang + "/dom-query/", guests = {}, iterations = total / size;
          let direct;
          for (const idx of orders[round % modes.length]) {
            const mode = modes[idx];
            if (mode === "direct") {
              direct = await instantiateDomGuest(base + "release/dom_query.core.wasm");
              guests.direct = direct.run;
            } else guests[mode] = (await import(base + mode + "/dom_query.js")).run;
          }
          const clear = () => { document.body.replaceChildren(); performance.clearMarks(); performance.clearMeasures(); };
          // Count the actual host results for every mode before timing. Restore the
          // original method before warmup so instrumentation stays out of the measured loop.
          const proto = Document.prototype, original = proto.getElementsByClassNameList;
          const hostCounts = {};
          for (const mode of modes) {
            let calls = 0, elements = 0;
            proto.getElementsByClassNameList = function (...args) {
              const list = original.apply(this, args);
              if (!Array.isArray(list) || list.length !== size) throw Error("Wrong host result");
              calls++; elements += list.length;
              return list;
            };
            try { clear(); guests[mode](size, iterations); }
            finally { proto.getElementsByClassNameList = original; }
            if (calls !== iterations || elements !== total) throw Error("Wrong host work: " + mode);
            hostCounts[mode] = {calls, elements};
          }
          const rows = [];
          for (let pass = 0; pass < 2 * modes.length; pass++) {
            for (const [position, idx] of orders[(round + pass) % modes.length].entries()) {
              const mode = modes[idx];
              clear(); guests[mode](size, iterations);
              const reports = Object.values(getMeasurements());
              if (reports.length !== 1 || document.querySelectorAll('[id^="item-"]').length !== size) throw Error("Invalid query fixture");
              const bulkMs = reports[0]["bulk: total ms"] * 1000;
              if (!Number.isFinite(bulkMs) || bulkMs <= 0) throw Error("Invalid bulk duration");
              if (pass >= modes.length) rows.push({pass, position, mode, bulkMs});
            }
            const c = direct.counts();
            if (c.liveHandles !== 0 || c.listCount !== (pass + 2) * iterations || c.listElements !== (pass + 2) * total) {
              throw Error("Direct host handle mismatch: " + JSON.stringify(c));
            }
          }
          return {rows, hostCounts, direct: direct.counts()};
        }, {lang, size, total, modes, orders, round});
        samples.push(...data.rows.map(row => ({lang, size, round, ...row})));
        checks.push({lang, size, round, hostCounts: data.hostCounts, direct: data.direct});
      } finally { await page.close(); }
    }
    console.log("Completed bulk DOM round", round + 1, "of", rounds);
  }
  await writeFile(output, gzipSync(JSON.stringify({revision, release:inventory.baseline, chromium:await browser.version(), rounds, sizes,
    languages, total, modes, manifest, compilers, ...(checked ? {matrixSha256: hash(matrixBytes)} : {}), runnerSha256:hash(await readFile(import.meta.filename)), samples, checks})));
} finally {
  await browser?.close();
  server.closeAllConnections(); server.close();
}
