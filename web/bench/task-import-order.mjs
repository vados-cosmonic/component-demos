// Expose two existing dependencies to Chromium when it parses the async-task entry.
// The paired pages download the same URLs and run the same C component.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createSecureServer } from "node:http2";
import { tmpdir } from "node:os";
import { basename, join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliCompressSync, gunzipSync, gzipSync } from "node:zlib";
import { parse } from "acorn";
import puppeteer from "puppeteer-core";

const [checkout, matrixPath, output] = process.argv.slice(2);
assert(output, "Usage: task-import-order.mjs <built Jco> <matrix.gz> <result.gz>");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const matrixBytes = await readFile(matrixPath), matrix = JSON.parse(gunzipSync(matrixBytes));
const ref = matrix.samples.find(s => s.lang === "c" && s.demo === "table-update" && s.version === "external");
const paths = ref.requests.map(r => r.path).sort();
const web = join(import.meta.dirname, ".."), assets = new Map(), imports = {};
function add(path, bytes) {
  assert.equal(hash(bytes), matrix.manifest[path].sha256, path);
  assets.set(path, Buffer.from(bytes));
}
const map = Object.fromEntries((await readFile(join(web, "host/imports.txt"), "utf8")).trim().split("\n").map(line => {
  const [id, symbol] = line.split(/\s+/);
  return [id, "../../../host/web-host.js#" + symbol];
}));
const { transpileBytes } = await import(pathToFileURL(resolve(checkout, "packages/jco-transpile/dist/transpile.js")));
const guest = await readFile(join(web, "c/table-update/native/table_update.wasm"));
const { files } = await transpileBytes(guest, { name: "table_update", minify: true, nodejsCompat: false, map,
  base64Cutoff: 5000, namespacedExports: true, emitTypescriptDeclarations: false, cmRuntimeEsModule: matrix.checkedPackage });
for (const path of paths) {
  if (path.startsWith("/runtime/")) {
    const rel = path.slice(9);
    add(path, await readFile(join(checkout, "packages/jco-cm-runtime/dist", rel)));
    imports[matrix.checkedPackage + "/" + rel.slice(0,-3)] = path;
  } else add(path, files[basename(path)]);
}
for (const path of ["/host/common.js", "/host/web-host.js", "/examples/table-update/main.js"])
  add(path, await readFile(join(web, path)));

function dependencies(path, bytes) {
  return parse(bytes.toString(), { ecmaVersion: "latest", sourceType: "module" }).body
    .filter(node => node.source?.value.startsWith("."))
    .map(node => posix.join(posix.dirname(path), node.source.value));
}
const facade = "/runtime/intrinsics/async-task.js";
const direct = dependencies(facade, assets.get(facade));
const children = [...new Set(direct.flatMap(p => dependencies(p, assets.get(p))))].filter(p => !direct.includes(p)).sort();
assert.deepEqual(children.map(p => basename(p).split("-")[0]), ["conversion", "core"]);
// Append after existing imports so their evaluation order is preserved. These
// modules are already reached through the initial imports in the unchanged graph.
const extra = children.map(p => 'import "' + posix.relative(posix.dirname(facade), p) + '";').join("");
const changed = Buffer.concat([assets.get(facade), Buffer.from("\n" + extra + "\n")]);
assert.deepEqual(dependencies(facade, changed), [...direct, ...children]);
const encoded = new Map([...assets].map(([p, bytes]) => [p, brotliCompressSync(bytes)]));
const changedBr = brotliCompressSync(changed);
const dir = await mkdtemp(join(tmpdir(), "jco-task-import-order-"));
let key, cert;
try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(dir,"key"), "-out", join(dir,"cert")], {stdio:"ignore"});
  key = await readFile(join(dir,"key")); cert = await readFile(join(dir,"cert"));
} finally { await rm(dir, {recursive:true, force:true}); }
const pin = createHash("sha256").update(new X509Certificate(cert).publicKey.export({type:"spki",format:"der"})).digest("base64");
const html = '<!doctype html><script type="importmap">' + JSON.stringify({imports}) + '</script>';
let earlier = false;
function handler(req,res) {
  const path = new URL(req.url,"https://localhost").pathname;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin"); res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  if (path === "/") return res.writeHead(200, {"Content-Type":"text/html"}).end(html);
  if (!assets.has(path)) return res.writeHead(404).end();
  const br = req.httpVersionMajor === 2;
  if (br) res.setHeader("Content-Encoding","br");
  res.setHeader("Content-Type",path.endsWith(".wasm") ? "application/wasm" : "text/javascript");
  res.end(earlier && path === facade ? (br ? changedBr : changed) : (br ? encoded : assets).get(path));
}
async function measure({entry, rows}) {
  const {getMeasurements} = await import("/examples/table-update/main.js");
  await import("/host/web-host.js");
  performance.clearResourceTimings();
  const start = performance.now();
  const {run} = await import(entry);
  const ready = performance.now()-start;
  run(rows);
  const firstResult = performance.now()-start;
  const reports = Object.values(getMeasurements());
  if (reports.length !== 1 || Object.keys(reports[0]).length !== 6 || !Object.values(reports[0]).every(v => v > 0 && Number.isFinite(v)))
    throw Error("Invalid C table result");
  const requests = performance.getEntriesByType("resource").map(r => ({path:new URL(r.name).pathname,
    start:r.startTime-start, request:r.requestStart-start, firstByte:r.responseStart-start, end:r.responseEnd-start,
    encoded:r.encodedBodySize, decoded:r.decodedBodySize, protocol:r.nextHopProtocol}));
  return {ready, firstResult, requests};
}
const profiles = ["http1", "h2", "limited-h2"], samples = [], servers = [createServer(handler),createSecureServer({key,cert},handler)];
const network = {latency:40,download:1250000,upload:1250000};
let browser;
try {
  for (const server of servers) await new Promise((ok,fail) => server.once("error",fail).listen(0,"127.0.0.1",ok));
  browser = await puppeteer.launch({ executablePath:process.env.CHROME_BIN, pipe:true,
    args:["--ignore-certificate-errors-spki-list=" + pin, ...(process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [])] });
  for (let round = 0; round < 18; round++) {
    for (const [position,index] of [0,1,5,2,4,3].entries()) {
      const arm = (round+index)%6, profile = profiles[Math.floor(arm/2)], h2 = profile !== "http1";
      earlier = Boolean(arm%2);
      const context = await browser.createBrowserContext();
      try {
        const page = await context.newPage();
        if (profile === "limited-h2") await page.emulateNetworkConditions(network);
        await page.goto((h2 ? "https" : "http") + "://127.0.0.1:" + servers[Number(h2)].address().port);
        const result = await page.evaluate(measure,{entry:ref.entry,rows:matrix.workloads["table-update"].rows});
        assert.deepEqual(result.requests.map(r=>r.path).sort(),paths);
        for (const r of result.requests) {
          const altered = earlier && r.path === facade;
          assert.equal(r.decoded,(altered ? changed : assets.get(r.path)).length);
          assert.equal(r.encoded,h2 ? (altered ? changedBr : encoded.get(r.path)).length : r.decoded);
          assert.equal(r.protocol,h2 ? "h2" : "http/1.1");
        }
        samples.push({round,position,profile,earlier,...result});
      } finally { await context.close(); }
    }
  }
  await writeFile(output,gzipSync(JSON.stringify({ matrix:hash(matrixBytes), runner:hash(await readFile(import.meta.filename)),
    browser:await browser.version(), network, facade, children, original:hash(assets.get(facade)), changed:hash(changed),
    rawBytesAdded:changed.length-assets.get(facade).length, brotliBytesAdded:changedBr.length-encoded.get(facade).length, samples })));
} finally { await browser?.close(); for (const s of servers) await new Promise(resolve=>s.close(resolve)); }
