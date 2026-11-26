// Compare the real canvas host with replay of its unchanged pixels on the same guest cores.
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {createServer} from "node:http";
import {readFile, readdir, writeFile} from "node:fs/promises";
import {basename, join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {gzipSync, gunzipSync} from "node:zlib";
import puppeteer from "puppeteer-core";

const [checkout, output] = process.argv.slice(2);
assert(checkout && output, "Usage: canvas-bindings.mjs <built Jco checkout> <result.json.gz>");
const bench = import.meta.dirname, web = join(bench, "..");
const hash = b => createHash("sha256").update(b).digest("hex");
const matrixBytes = await readFile(join(bench, "results/review-matrix-minified-eaca992c8.json.gz"));
const matrix = JSON.parse(gunzipSync(matrixBytes));
const git = (...args) => execFileSync("git", args, {cwd: checkout, encoding: "utf8"}).trim();
assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
const revision = git("rev-parse", "HEAD");
const {transpileBytes} = await import(pathToFileURL(resolve(checkout, "packages/jco-transpile/dist/transpile.js")));
const map = Object.fromEntries((await readFile(join(web, "host/imports.txt"), "utf8")).trim().split("\n").map(line => {
  const [name, symbol] = line.split(/\s+/);
  return [name, "../../../host/web-host.js#" + symbol];
}));
const languages = ["c", "cpp", "rust"], hosts = ["original", "observed", "replay"];
const modes = ["direct", "release", "bundled", "external"];
const rounds = Number(process.env.ROUNDS ?? 12);
assert(Number.isInteger(rounds) && rounds >= 8 && rounds % 4 === 0);
const assets = new Map(), hashes = {};
function register(path, bytes, verify = true) {
  hashes[path] = hash(bytes);
  if (verify) assert.equal(hashes[path], matrix.manifest[path]?.sha256, path);
  assets.set(path, bytes);
}
for (const path of ["host/web-host.js", "host/common.js", "examples/canvas-pixels/main.js",
                    "bench/dom-core-shim.mjs", "bench/canvas-host.mjs", "bench/canvas-readback.mjs"]) {
  register("/" + path, await readFile(join(web, path)), !path.startsWith("bench/"));
}
const runtime = join(checkout, "packages/jco-cm-runtime/dist");
for (const f of await readdir(runtime, {recursive: true})) {
  if (f.endsWith(".js") && !f.startsWith("debug/")) register("/runtime/" + f, await readFile(join(runtime, f)));
}
for (const lang of languages) {
  const base = "/" + lang + "/canvas-pixels/", name = "canvas_pixels";
  const guest = await readFile(join(web, base, "native", name + ".wasm"));
  for (const path of Object.keys(matrix.manifest).filter(p => p.startsWith(base + "release/"))) {
    register(path, await readFile(join(web, base, "jco-baseline-minified", basename(path))));
  }
  for (const mode of ["bundled", "external"]) {
    const opts = {name, minify: true, nodejsCompat: false, base64Cutoff: 5000, namespacedExports: true,
      emitTypescriptDeclarations: false, map: {...map}};
    if (mode === "external") Object.assign(opts, {cmRuntimeEsModule: "/runtime", cmRuntimeSyncImports: true});
    const {files} = await transpileBytes(guest, opts);
    for (const [f, b] of Object.entries(files)) {
      register(base + mode + "/" + f, b);
      if (f.endsWith(".wasm")) assert.equal(hash(b), hashes[base + "release/" + f]);
    }
  }
}

async function measure({lang, host, modes, orders, size, minMs}) {
  const {getMeasurements} = await import("/examples/canvas-pixels/main.js");
  const {checkCanvasPixels} = await import("/bench/canvas-host.mjs");
  const {instantiateDomGuest} = await import("/bench/dom-core-shim.mjs");
  const proto = CanvasRenderingContext2D.prototype;
  const snapshots = new Map();
  let activeMode, context, fills = 0, reads = 0;
  if (host === "replay") {
    const read = proto.getImageDataArrayBuffer;
    proto.getImageDataArrayBuffer = function(x, y, width, height) {
      if (x !== 40 || y !== 40 || width !== size - 80 || height !== size - 80) throw Error("Changed source rectangle");
      // Each build renders the same checkerboard on every invocation. Save that
      // build's actual bytes during warm-up so even a one-call timed trial
      // exercises the ABI without having to fetch or copy fresh host pixels.
      if (!context) context = this;
      if (context !== this) throw Error("Changed source context during one guest run");
      if (!snapshots.has(activeMode)) {
        const bytes = read.call(this, x, y, width, height);
        if (bytes.length !== width * height * 4) throw Error("Changed source length");
        snapshots.set(activeMode, bytes);
        fills++;
      }
      reads++;
      return snapshots.get(activeMode);
    };
  }
  const observer = host === "observed" ? (await import("/bench/canvas-readback.mjs")).observeReadback(size) : undefined;
  const base = "/" + lang + "/canvas-pixels/", guests = {};
  for (const idx of orders[0]) {
    const mode = modes[idx];
    guests[mode] = mode === "direct" ? await instantiateDomGuest(base + "release/canvas_pixels.core.wasm") :
      await import(base + mode + "/canvas_pixels.js");
  }
  const samples = [];
  for (const [pass, order] of orders.entries()) for (const [position, idx] of order.entries()) {
    const mode = modes[idx];
    document.body.replaceChildren(); performance.clearMarks(); performance.clearMeasures();
    activeMode = mode; context = undefined; fills = 0; reads = 0;
    guests[mode].run(size, minMs);
    const reports = Object.values(getMeasurements());
    if (reports.length !== 1) throw Error("Missing canvas report");
    const readUs = reports[0]["getImageData(): µs/call"] * 1e6;
    const writeUs = reports[0]["putImageData(): µs/call"] * 1e6;
    if (![readUs, writeUs].every(x => Number.isFinite(x) && x > 0)) throw Error("Invalid timings");
    const observed = observer?.finish(readUs / 1e6);
    if (host === "replay" && (fills !== Number(pass === 0) || reads < 1 || (reads & (reads + 1)) !== 0)) {
      throw Error(`Unexpected replay counts for ${lang}/${mode} pass ${pass}: ${fills} fills, ${reads} reads`);
    }
    const pixels = checkCanvasPixels(size);
    if (guests.direct.counts().liveHandles !== 0) throw Error("Unreleased resource handle");
    if (pass > 0) samples.push({pass, position, mode, readUs, writeUs, pixels, observed, fills, reads});
  }
  return samples;
}

const server = createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  if (path === "/") return res.writeHead(200, {"Content-Type":"text/html"}).end("<!doctype html><body>");
  if (!assets.has(path)) return res.writeHead(404).end();
  res.writeHead(200, {"Content-Type":path.endsWith(".wasm") ? "application/wasm" : "text/javascript"}).end(assets.get(path));
});
const sequences = [[0,1,3,2],[1,2,0,3],[2,3,1,0],[3,0,2,1]];
const samples = [], size = 256, minMs = 10;
let browser;
try {
  await new Promise((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
  browser = await puppeteer.launch({executablePath: process.env.CHROME_BIN, channel: process.env.CHROME_BIN ? undefined : "chrome",
    args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []});
  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < languages.length; i++) for (let j = 0; j < hosts.length; j++) {
      const lang = languages[(round + i) % 3], host = hosts[(round + i + j) % 3];
      const orders = Array.from({length:5}, (_, p) => sequences[(round + p) % 4]);
      const page = await browser.newPage();
      try {
        await page.goto("http://127.0.0.1:" + server.address().port);
        const rows = await page.evaluate(measure, {lang, host, modes, orders, size, minMs});
        samples.push(...rows.map(row => ({round, lang, host, ...row})));
      } finally { await page.close(); }
    }
    console.log("Completed canvas round", round + 1, "of", rounds);
  }
  await writeFile(output, gzipSync(JSON.stringify({revision, rounds, size, minMs, languages, hosts, modes,
    browser: await browser.version(), matrixSha256: hash(matrixBytes), runnerSha256: hash(await readFile(import.meta.filename)), hashes, samples})));
} finally { await browser?.close(); server.closeAllConnections(); server.close(); }
