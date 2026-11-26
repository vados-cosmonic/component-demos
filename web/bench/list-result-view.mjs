// Measure the cost of refreshing a guest memory view between the two stores
// that return a WIT list. The experiment changes only generated adapters.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { parse } from "@bytecodealliance/jco";
import puppeteer from "puppeteer-core";

const [compiler, runtime, output] = process.argv.slice(2);
assert(output, "Usage: list-result-view.mjs <built jco-transpile directory> <runtime dist> <result.json.gz>");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const web = resolve(import.meta.dirname, "..");
const matrixBytes = await readFile(join(web, "bench/results/review-matrix-init-ae16355e9.json.gz"));
const matrix = JSON.parse(gunzipSync(matrixBytes));
const { transpileBytes } = await import(pathToFileURL(resolve(compiler, "dist/transpile.js")));
const { minify } = createRequire(resolve(compiler, "package.json"))("oxc-minify");
const provider = "@bytecodealliance/jco-cm-runtime";
const assets = new Map(), manifest = {}, sites = {}, imports = {};
function add(path, bytes, control) {
  assert(!assets.has(path), path);
  bytes = Buffer.from(bytes);
  if (control) assert.equal(hash(bytes), matrix.manifest[control].sha256, control);
  assets.set(path, bytes);
  manifest[path] = { sha256: hash(bytes), bytes: bytes.length };
}
for (const file of await readdir(runtime, { recursive: true })) {
  if (!file.endsWith(".js") || file.startsWith("debug/")) continue;
  const path = "/runtime/" + file;
  add(path, await readFile(join(runtime, file)), path);
  imports[provider + "/" + file.slice(0, -3)] = path;
}
for (const path of ["host/web-host.js", "host/common.js", "examples/canvas-pixels/main.js", "examples/string-marshalling/main.js", "bench/canvas-host.mjs"]) {
  add("/" + path, await readFile(join(web, path)), path.startsWith("bench/") ? undefined : "/" + path);
}
const map = Object.fromEntries((await readFile(join(web, "host/imports.txt"), "utf8")).trim().split("\n").map(line => {
  const [name, symbol] = line.split(/\s+/);
  return [name, "../../../host/web-host.js#" + symbol];
}));
const fixture = await readFile(join(web, "bench/byte-transfer.wat"), "utf8");
const cases = ["copy", ...["canvas-pixels", "string-marshalling"].flatMap(demo =>
  ["c", "cpp", "rust"].map(lang => lang + "/" + demo))];
const modes = ["bundled", "external", "bundled-trial", "external-trial"];
for (const guest of cases) {
  const demo = guest.split("/")[1], name = demo?.replaceAll("-", "_") ?? "copy";
  const base = demo ? "/" + guest + "/" : "/fixture/";
  const component = demo ? await readFile(join(web, base, "native", name + ".wasm")) : await parse(fixture);
  for (const mode of modes.slice(0, 2)) {
    const options = { name, nodejsCompat: false, emitTypescriptDeclarations: false,
      ...(demo ? { namespacedExports: true, base64Cutoff: 5000, map } : { instantiation: "async", base64Cutoff: 0 }),
      ...(mode === "external" ? { cmRuntimeEsModule: provider } : {}) };
    const control = (await transpileBytes(component, { ...options, minify: true })).files;
    const raw = (await transpileBytes(component, { ...options, minify: false })).files;
    const source = Buffer.from(raw[name + ".js"]).toString();
    const compress = async code => {
      const result = await minify("component.js", code, { module: true,
        compress: { target: "es2019", dropLabels: mode === "external" ? ["DEBUG"] : [] }, mangle: { keepNames: true } });
      assert.deepEqual(result.errors, []);
      return result.code;
    };
    // Match one complete pointer/length pair from this compiler. The Oxc bundle
    // removes a parenthesis layer and shortens the boolean before minification.
    const stores = /^(\s*)(dataView\(_jcoDataViewCacheContext, memory\d+\))\.setUint32\((\(+(arg\d+) >>> 0\)+) \+ 4, (len\d+), (true|!0)\);\s*\2\.setUint32\(\3 \+ 0, (ptr\d+), \6\);/gm;
    let count = 0;
    const trial = source.replace(stores, (_, indent, view, address, arg, len, le, ptr) => {
      count++;
      // A nonnumeric address or length can run JS during conversion, including
      // growing memory. In that case refresh the view before the second store.
      return indent + `{ const resultView = ${view};
        resultView.setUint32(${address} + 4, ${len}, ${le});
        (typeof ${arg} === "number" && typeof ${len} === "number" ? resultView : ${view}).setUint32(${address}, ${ptr}, ${le}); }`;
    });
    assert.equal(count, 1, base + mode);
    sites[base + mode] = count;
    assert.equal(await compress(source), Buffer.from(control[name + ".js"]).toString());
    for (const [file, bytes] of Object.entries(control)) {
      const path = base + mode + "/" + file;
      add(path, bytes, demo ? path : undefined);
      const modified = file === name + ".js" ? await compress(trial) : bytes;
      if (file.endsWith(".wasm")) assert.deepEqual(bytes, raw[file]);
      add(base + mode + "-trial/" + file, modified);
    }
  }
}

// Runs inside the page. Each group of four passes counterbalances timing
// positions and immediate predecessors. The first four passes warm each build.
async function measure({ guest, modes, round }) {
  const guests = {}, rows = [], lengths = [16, 256, 4096, 123904];
  const orders = [[0,1,3,2], [1,2,0,3], [2,3,1,0], [3,0,2,1]];
  const demo = guest.split("/")[1];
  let buffers, getMeasurements, checkCanvasPixels;
  for (const index of orders[round % 4]) {
    const mode = modes[index];
    if (guest === "copy") {
      const { instantiate } = await import("/fixture/" + mode + "/copy.js");
      guests[mode] = await instantiate(name => WebAssembly.compileStreaming(fetch("/fixture/" + mode + "/" + name)),
        { read: { default(length, pattern) {
          if (buffers[pattern].length !== length) throw Error("Unexpected host payload");
          return buffers[pattern];
        } } });
    } else {
      ({ getMeasurements } = await import("/examples/" + demo + "/main.js"));
      if (demo === "canvas-pixels") ({ checkCanvasPixels } = await import("/bench/canvas-host.mjs"));
      guests[mode] = await import("/" + guest + "/" + mode + "/" + demo.replaceAll("-", "_") + ".js");
    }
  }
  // Each string invocation already measures all five payload sizes with an
  // autoranging guest loop. Rotate its single measured pass across pages.
  if (demo === "string-marshalling") {
    for (let pass = 0; pass < 2; pass++) for (const [position, index] of orders[(round + pass) % 4].entries()) {
      document.body.replaceChildren(); performance.clearMarks(); performance.clearMeasures();
      const mode = modes[index];
      guests[mode].run(10);
      const reports = Object.values(getMeasurements());
      if (reports.length !== 1 || Object.keys(reports[0]).length !== 10) throw Error("Missing string measurements");
      for (const length of [8,128,1024,16384,262144]) {
        const nsPerCall = reports[0]["get " + length + " B"] * 1e9;
        if (!Number.isFinite(nsPerCall) || nsPerCall <= 0) throw Error("Invalid string duration");
        if (pass === 1) rows.push({ guest, round, pass, position, mode, length, nsPerCall });
      }
    }
    return rows;
  }
  for (const length of guest === "copy" ? lengths.slice(round % 4).concat(lengths.slice(0,round % 4)) : [123904]) {
    const count = length < 1024 ? 32768 : length === 4096 ? 8192 : 512;
    buffers = [0,1].map(pattern => {
      const bytes = new Uint8Array(length + 14).subarray(7, -7);
      for (let i = 0; i < length; i++) bytes[i] = (i + 31 * pattern) & 255;
      return bytes;
    });
    const sum = count / 2 * buffers.reduce((s,b) => s + b[0] + b.at(-1), 0);
    const digest = buffers[1].reduce((a,b) => Math.imul(a ^ b,16777619),2166136261) >>> 0;
    for (let pass = 0; pass < 8; pass++) for (const [position, index] of orders[(round + pass) % 4].entries()) {
      const mode = modes[index], instance = guests[mode];
      let elapsed;
      if (guest === "copy") {
        const start = performance.now(), result = instance.run(length, count);
        elapsed = (performance.now() - start) * 1e6 / count;
        if (result !== sum || (instance.digest(length) >>> 0) !== digest) throw Error("Incorrect bytes");
      } else {
        document.body.replaceChildren(); performance.clearMarks(); performance.clearMeasures();
        instance.run(256, 10);
        const reports = Object.values(getMeasurements());
        if (reports.length !== 1) throw Error("Missing guest report");
        elapsed = reports[0]["getImageData(): µs/call"] * 1e9;
        checkCanvasPixels(256);
      }
      if (!Number.isFinite(elapsed) || elapsed <= 0) throw Error("Invalid duration");
      if (pass >= 4) rows.push({ guest, round, pass, position, mode, length, nsPerCall: elapsed });
    }
  }
  return rows;
}

const server = createServer((req,res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  if (path === "/") return res.writeHead(200, { "Content-Type": "text/html" }).end(
    '<!doctype html><script type="importmap">' + JSON.stringify({ imports }) + '</script><body>');
  if (!assets.has(path)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": path.endsWith(".wasm") ? "application/wasm" : "text/javascript" }).end(assets.get(path));
});
const rounds = Number(process.env.ROUNDS ?? 16);
assert(Number.isInteger(rounds) && rounds >= 8 && rounds % 4 === 0);
const samples = [];
let browser;
try {
  await new Promise((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN, pipe: true,
    args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [] });
  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < cases.length; i++) {
      const guest = cases[(round + i) % cases.length], page = await browser.newPage();
      try {
        await page.goto("http://127.0.0.1:" + server.address().port);
        samples.push(...await page.evaluate(measure, { guest, modes, round }));
      } finally { await page.close(); }
    }
    console.log("Finished round", round + 1, "of", rounds);
  }
  await writeFile(output, gzipSync(JSON.stringify({ rounds, modes, sites, manifest, samples,
    compiler: hash(await readFile(join(compiler, "vendor/js-component-bindgen-component.core.wasm"))),
    browser: await browser.version(), runner: hash(await readFile(import.meta.filename)),
    fixture: hash(fixture), matrix: hash(matrixBytes) })));
} finally { await browser?.close(); server.closeAllConnections(); server.close(); }
