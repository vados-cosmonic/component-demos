// Pass a fresh host resource into a synchronous guest export that drops it.
// Separate retention pages from timings so instrumentation never runs on the timed path.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { parse, transpile } from "@bytecodealliance/jco";
import puppeteer from "puppeteer-core";

const [checkout, before, after, output] = process.argv.slice(2);
assert(output, "Usage: owned-resource-history.mjs <Jco checkout> <before jco-transpile> <after jco-transpile> <result.json.gz>");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fixture = "packages/jco-transpile/test/fixtures/components/runtime/zero-host-resource-rep.component.wat";
const input = await parse(await readFile(join(checkout, fixture), "utf8"));
const options = { name: "owned", instantiation: "async", nodejsCompat: false, base64Cutoff: 0, minify: true };
const provider = "@bytecodealliance/jco-cm-runtime", assets = new Map(), imports = {}, entries = {}, compilers = {};
let core;
function record(mode, files) {
  const wasm = Object.keys(files).filter(f => f.endsWith(".wasm"));
  assert.deepEqual(wasm, ["owned.core.wasm"]);
  const bytes = Buffer.from(files[wasm[0]]);
  core ??= bytes;
  assert.deepEqual(core, bytes);
  const js = Buffer.from(files["owned.js"]);
  entries[mode] = { sha256: hash(js), bytes: js.length, gzipBytes: gzipSync(js).length };
  assets.set("/" + mode + ".js", js);
}
record("release", (await transpile(input, { ...options })).files);
const runtime = join(checkout, "packages/jco-cm-runtime/dist");
const runtimeHashes = {};
for (const file of await readdir(runtime, { recursive: true })) {
  if (!file.endsWith(".js") || file.startsWith("debug/")) continue;
  const path = "/runtime/" + file, bytes = await readFile(join(runtime,file));
  assets.set(path, bytes);
  runtimeHashes[path] = hash(bytes);
  imports[provider + "/" + file.slice(0,-3)] = path;
}
for (const [revision, compiler] of [["before",before], ["after",after]]) {
  const { transpileBytes } = await import(pathToFileURL(resolve(compiler, "dist/transpile.js")));
  compilers[revision] = hash(await readFile(join(compiler, "vendor/js-component-bindgen-component.core.wasm")));
  for (const mode of ["bundled", "external"]) {
    record(revision + "-" + mode, (await transpileBytes(input, { ...options, emitTypescriptDeclarations: false,
      ...(mode === "external" ? { cmRuntimeEsModule: provider } : {}) })).files);
  }
}
assert.notEqual(compilers.before, compilers.after);
assets.set("/guest.wasm", core);
const modes = Object.keys(entries), html = '<!doctype html><script type="importmap">' + JSON.stringify({imports}) + '</script>';
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  if (path === "/") return res.writeHead(200, {"Content-Type":"text/html"}).end(html);
  if (!assets.has(path)) return res.writeHead(404).end();
  res.writeHead(200, {"Content-Type":path.endsWith(".wasm") ? "application/wasm" : "text/javascript"}).end(assets.get(path));
});

// A live numeric history can survive after every destructor has run. WeakRefs
// let Chromium collect unrelated temporary sets before their entries are counted.
async function prepare({ modes, observe }) {
  const core = await WebAssembly.compileStreaming(fetch("/guest.wasm"));
  const guests = {};
  for (const mode of modes) {
    const { instantiate } = await import("/" + mode + ".js");
    let drops = 0, calls = 0;
    class Thing { [Symbol.dispose ?? Symbol.for("dispose")]() { drops++; } }
    const refs = [], NativeSet = globalThis.Set;
    let instance;
    try {
      if (observe) globalThis.Set = class extends NativeSet {
        constructor(...args) { super(...args); refs.push(new WeakRef(this)); }
      };
      instance = await instantiate(() => core, { "test:zero-rep/api": { Thing }, observe: {default: () => 1} });
    } finally { globalThis.Set = NativeSet; }
    guests[mode] = {
      run(count) {
        const start = performance.now();
        for (let i = 0; i < count; i++) instance.drop(new Thing());
        const ns = (performance.now() - start) * 1e6 / count;
        calls += count;
        if (drops !== calls) throw Error("Wrong disposal count for " + mode + ": " + drops + "/" + calls);
        return ns;
      },
      inspect() {
        const numericSets = [];
        for (const ref of refs) {
          const set = ref.deref();
          if (set?.size && typeof set.values().next().value === "number") numericSets.push(set.size);
        }
        return { drops, numericSets };
      },
    };
  }
  globalThis.guests = guests;
}

let browser;
const retention = [], timings = [];
try {
  await new Promise((ok, fail) => server.once("error",fail).listen(0,"127.0.0.1",ok));
  browser = await puppeteer.launch({executablePath:process.env.CHROME_BIN,pipe:true,
    args:process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []});
  const url = "http://127.0.0.1:" + server.address().port;
  for (const mode of modes) {
    const page = await browser.newPage();
    try {
      await page.goto(url);
      await page.evaluate(prepare, { modes: [mode], observe: true });
      const client = await page.createCDPSession();
      let previous = 0;
      for (const calls of [0,8192,32768,131072]) {
        if (calls > previous) await page.evaluate((m,n) => globalThis.guests[m].run(n), mode, calls-previous);
        await client.send("HeapProfiler.collectGarbage");
        const { drops, numericSets } = await page.evaluate(m => globalThis.guests[m].inspect(),mode);
        assert.equal(drops, calls);
        if (mode !== "release") assert.deepEqual(numericSets, calls && mode.startsWith("before") ? [calls] : []);
        retention.push({ mode, calls, drops, numericSets });
        previous = calls;
      }
    } finally { await page.close(); }
  }
  // Ten Williams sequences counterbalance position and immediate predecessor
  // for five treatments. Each page warms all instances before taking samples.
  const orders = [];
  for (let shift = 0; shift < modes.length; shift++) {
    const row = [0,1,4,2,3].map(i => modes[(i+shift) % modes.length]);
    orders.push(row, row.toReversed());
  }
  for (let round = 0; round < 20; round++) {
    const page = await browser.newPage();
    try {
      await page.goto(url);
      const order = orders[round % orders.length];
      await page.evaluate(prepare, { modes: order, observe: false });
      const rows = await page.evaluate(({ order, orders, round }) => {
        for (const mode of order) globalThis.guests[mode].run(2048);
        const rows = [];
        for (let pass = 0; pass < 3; pass++) {
          for (const [position, mode] of orders[(round+pass) % orders.length].entries()) {
            const nsPerCall = globalThis.guests[mode].run(8192);
            if (!(nsPerCall > 0)) throw Error("Invalid timing");
            rows.push({ round, pass, position, mode, nsPerCall });
          }
        }
        return rows;
      }, { order, orders, round });
      timings.push(...rows);
    } finally { await page.close(); }
  }
  await writeFile(output,gzipSync(JSON.stringify({ browser:await browser.version(), core:hash(core), input:hash(input),
    release:JSON.parse(await readFile(join(import.meta.dirname,"../node_modules/@bytecodealliance/jco/package.json"))).version,
    runner:hash(await readFile(import.meta.filename)), entries, compilers, runtimeHashes, retention, timings })));
} finally { await browser?.close(); server.closeAllConnections(); server.close(); }
