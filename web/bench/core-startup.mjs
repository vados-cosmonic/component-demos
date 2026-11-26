// Compare fetching the primary Wasm core with embedding the identical bytes in the JS entry.
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {readFile, readdir, writeFile} from "node:fs/promises";
import {createServer} from "node:http";
import {join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {gunzipSync, gzipSync} from "node:zlib";
import {transpile} from "@bytecodealliance/jco";
import puppeteer from "puppeteer-core";
import { parse } from "acorn";

const [checkout, output, study, ...extra] = process.argv.slice(2);
const preload = study === "--modulepreload";
assert(!extra.length && (study === undefined || preload));
assert(checkout && output, "Usage: core-startup.mjs <built Jco checkout> <output.json.gz> [--modulepreload]");
const rounds = Number(process.env.ROUNDS ?? 18);
assert(Number.isInteger(rounds) && rounds >= 6 && rounds % 6 === 0);
const bench = import.meta.dirname, web = join(bench, "..");
const hash = b => createHash("sha256").update(b).digest("hex");
const matrixFile = preload ? "review-matrix-minified-db4a3aca0.json.gz" : "review-matrix-minified-eaca992c8.json.gz";
const matrixBytes = await readFile(join(bench, "results", matrixFile));
const reference = JSON.parse(gunzipSync(matrixBytes)).manifest;
const git = (...args) => execFileSync("git", args, {cwd:checkout, encoding:"utf8"}).trim();
assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
const revision = git("rev-parse", "HEAD");
const release = JSON.parse(await readFile(join(web, "node_modules/@bytecodealliance/jco/package.json"))).version;
assert.equal(release, "1.13.0");
const {transpileBytes} = await import(pathToFileURL(resolve(checkout, "packages/jco-transpile/dist/transpile.js")));
const map = Object.fromEntries((await readFile(join(web, "host/imports.txt"), "utf8")).trim().split("\n").map(line => {
  const [n, s] = line.split(/\s+/);
  return [n, "../../../host/web-host.js#" + s];
}));
const assets = new Map(), manifest = {}, cases = [];
function add(path, bytes, compare) {
  const b = Buffer.from(bytes);
  const sha256 = hash(b);
  if (compare) assert.equal(sha256, reference[compare].sha256, compare);
  assets.set(path, b);
  manifest[path] = {bytes:b.length, gzip:gzipSync(b, {level:9}).length, sha256};
}
const inputs = {"dom-query":[8,2], "table-update":[8]};
for (const f of ["host/web-host.js","host/common.js",...Object.keys(inputs).map(d => "examples/"+d+"/main.js")]) {
  add("/"+f, await readFile(join(web,f)), "/"+f);
}
const runtime = join(checkout, "packages/jco-cm-runtime/dist");
for (const f of await readdir(runtime, {recursive:true})) {
  if (f.endsWith(".js") && !f.startsWith("debug/")) add("/runtime/"+f, await readFile(join(runtime,f)), "/runtime/"+f);
}
const modes = [];
const provider = "@bytecodealliance/jco-cm-runtime";
const imports = Object.fromEntries([...assets.keys()].filter(p => p.startsWith("/runtime/")).map(p =>
  [provider + p.slice("/runtime".length, -3), p]));
for (const build of ["release","bundled","external"]) for (const inline of (preload ? [false] : [false,true])) {
  const mode = build + (inline ? "-inline" : "");
  modes.push(mode);
  for (const demo of Object.keys(inputs)) for (const lang of ["c","cpp","rust"]) {
    const base = "/"+lang+"/"+demo, name = demo.replaceAll("-","_");
    const guest = await readFile(join(web,base,"native",name+".wasm"));
    const core = name+".core.wasm", js = name+".js";
    const ref = base+"/"+build+"/";
    const options = {name, minify:true, nodejsCompat:false, map:{...map}};
    if (build !== "release") Object.assign(options, {namespacedExports:true, emitTypescriptDeclarations:false});
    if (build === "external") Object.assign(options, preload ? {cmRuntimeEsModule:provider} : {cmRuntimeEsModule:"/runtime",cmRuntimeSyncImports:true});
    options.base64Cutoff = inline ? 256*1024 : 5000;
    const {files} = await (build === "release" ? transpile : transpileBytes)(guest, options);
    const emitted = Object.keys(files).filter(f => /\.(js|wasm)$/.test(f));
    assert.deepEqual(emitted.sort(), inline ? [js] : [core,js]);
    for (const f of emitted) add(base+"/"+mode+"/"+f, files[f], inline ? null : ref+f);
    if (inline) {
      // Validate every embedded core, including the small adapters the control
      // already embeds. A change in packaging must never change the guest.
      const blobs = bytes => [...bytes.toString().matchAll(/["'`](AGFzbQ[A-Za-z0-9+/=]+)["'`]/g)]
        .map(m => hash(Buffer.from(m[1],"base64"))).sort();
      const smaller = blobs(assets.get(ref+js));
      assert(smaller.length >= 1);
      assert.deepEqual(blobs(assets.get(base+"/"+mode+"/"+js)), [...smaller,reference[ref+core].sha256].sort());
    }
    if (mode === "release") cases.push({base,demo,name});
  }
}

// Derive hints from the static module graph so the list travels with the deployed
// runtime. A new package build can change private chunk names and boundaries.
function dependencies(path) {
  const ast = parse(assets.get(path).toString(), {ecmaVersion:"latest", sourceType:"module"});
  return ast.body.filter(stmt => stmt.source && ["ImportDeclaration","ExportNamedDeclaration","ExportAllDeclaration"].includes(stmt.type))
    .map(stmt => imports[stmt.source.value] ?? new URL(stmt.source.value,"http://localhost"+path).pathname)
    .filter(target => target.startsWith("/runtime/"));
}
const hintLists = {};
if (preload) {
  modes.push("direct", "transitive", "all");
  for (const {base,name} of cases) {
    const direct = [...new Set(dependencies(base+"/external/"+name+".js"))];
    const all = new Set(direct);
    for (const path of all) for (const dependency of dependencies(path)) all.add(dependency);
    const transitive = [...all].filter(path => !direct.includes(path));
    assert(direct.length && transitive.length);
    hintLists[base] = {direct, transitive, all:[...all]};
  }
}

async function measure({demo,entry,args,hints}) {
  const {getMeasurements} = await import("/examples/"+demo+"/main.js");
  await import("/host/web-host.js");
  performance.clearResourceTimings();
  const start = performance.now();
  for (const path of hints ?? []) {
    const link = document.createElement("link");
    link.rel = "modulepreload";
    link.href = path;
    document.head.append(link);
  }
  const {run} = await import(entry);
  const ready = performance.now();
  run(...args);
  const first = performance.now();
  const reports = Object.values(getMeasurements());
  if (reports.length !== 1 || Object.keys(reports[0]).length !== (demo === "dom-query" ? 3 : 6) ||
      !Object.values(reports[0]).every(v => Number.isFinite(v) && v >= 0)) throw Error("Invalid guest report");
  return {loadMs:ready-start, firstMs:first-start, requests:performance.getEntriesByType("resource").map(e => ({
    path:new URL(e.name).pathname, bytes:e.encodedBodySize, transferred:e.transferSize,
    ...(hints ? {startMs:e.startTime-start, endMs:e.responseEnd-start, initiator:e.initiatorType} : {}),
  }))};
}

// Across each six-round block, balance position and immediate predecessor for every build and layout.
const sequence = [0,1,5,2,4,3], samples = [];
let browserVersion;
for (let round = 0; round < rounds; round++) {
  const queue = [];
  for (let i = 0; i < cases.length; i++) {
    const item = cases[(i+round)%cases.length];
    const delays = preload ? ((round+i)%2 === 0 ? [0,10] : [10,0]) : [0];
    for (const delay of delays) {
      for (const slot of sequence) queue.push({...item, mode:modes[(slot+round)%6], delay});
    }
  }
  let cursor = 0;
  const gate = Promise.withResolvers(), done = Promise.withResolvers();
  done.promise.catch(() => {});
  const watchdog = setTimeout(() => done.reject(Error("Timed out at page "+cursor)), 60000);
  const server = createServer(async (req,res) => {
    try {
      res.setHeader("Cache-Control","no-store");
      res.setHeader("Cross-Origin-Opener-Policy","same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy","require-corp");
      const path = new URL(req.url,"http://localhost").pathname;
      if (path === "/") return res.writeHead(200, {"Content-Type":"text/html"}).end('<script>fetch("/gate").then(()=>location.replace("/trial/0"))</script>');
      if (path === "/gate") { await gate.promise; return res.end(); }
      if (path === "/favicon.ico") return res.writeHead(204).end();
      const {base,mode,name,demo,delay} = queue[cursor];
      const hints = preload ? hintLists[base][mode] ?? [] : undefined;
      const build = hints?.length ? "external" : mode;
      const entry = base+"/"+build+"/"+name+".js";
      if (path === "/trial/"+cursor) {
        const args = {demo,entry,args:inputs[demo],hints};
        const importMap = preload ? '<script type="importmap">'+JSON.stringify({imports})+'</script>' : "";
        return res.writeHead(200,{"Content-Type":"text/html"}).end(`<!doctype html><head>${importMap}</head><body><script type="module">
          let result; try { result=await (${measure})(${JSON.stringify(args)}); } catch(e) { result={error:String(e.stack||e)}; }
          const next=await(await fetch("/result/${cursor}",{method:"POST",body:JSON.stringify(result)})).text();
          if(next)location.replace(next);</script>`);
      }
      if (path === "/result/"+cursor && req.method === "POST") {
        let body = ""; for await (const part of req) body += part;
        const row = JSON.parse(body); assert(!row.error,row.error);
        assert(row.firstMs > row.loadMs && row.loadMs > 0);
        const seen = new Set();
        for (const r of row.requests) {
          assert.equal(manifest[r.path].bytes,r.bytes);
          assert(r.transferred > 0 && !seen.has(r.path));
          seen.add(r.path);
        }
        assert(seen.has(entry));
        assert.equal([...seen].filter(p => p.endsWith(".wasm")).length,Number(!mode.endsWith("-inline")));
        assert.equal([...seen].some(p => p.startsWith("/runtime/")),build.startsWith("external"));
        if (preload) {
          const expected = [entry,base+"/"+build+"/"+name+".core.wasm"];
          if (build === "external") expected.push(...hintLists[base].all);
          assert.deepEqual([...seen].sort(), expected.sort());
          for (const r of row.requests) {
            assert(r.startMs >= -0.02 && r.endMs >= r.startMs && r.endMs <= row.firstMs+0.02);
          }
          row.delay = delay;
        }
        samples.push({round,cursor,base,mode,...row});
        watchdog.refresh();
        if (++cursor === queue.length) { res.end(); done.resolve(); }
        else res.end("/trial/"+cursor);
        return;
      }
      assert(assets.has(path),path);
      if (delay && !path.startsWith("/host/") && !path.startsWith("/examples/")) {
        await new Promise(resolve => setTimeout(resolve,delay));
      }
      res.writeHead(200,{"Content-Type":path.endsWith(".wasm")?"application/wasm":"text/javascript"}).end(assets.get(path));
    } catch(e) { res.writeHead(500).end(); done.reject(e); }
  });
  let browser,endpoint;
  try {
    await new Promise((ok,fail) => server.once("error",fail).listen(0,"127.0.0.1",ok));
    browser = await puppeteer.launch({executablePath:process.env.CHROME_BIN, channel:process.env.CHROME_BIN?undefined:"chrome",
      args:process.env.CHROME_NO_SANDBOX==="1"?["--no-sandbox"]:[]});
    browserVersion = await browser.version();
    await (await browser.newPage()).goto("http://127.0.0.1:"+server.address().port);
    endpoint = browser.wsEndpoint(); await browser.disconnect(); gate.resolve();
    await done.promise;
  } finally {
    clearTimeout(watchdog); gate.resolve();
    try { if(endpoint) browser=await puppeteer.connect({browserWSEndpoint:endpoint}); await browser?.close(); }
    finally { server.closeAllConnections(); server.close(); }
  }
  console.log("Completed browser startup round",round+1,"of",rounds);
}
await writeFile(output,gzipSync(JSON.stringify({revision,release,browserVersion,rounds,inputs,modes,cases,manifest,samples,
  runnerSha256:hash(await readFile(import.meta.filename)),matrixSha256:hash(matrixBytes), ...(preload ? {study,hintLists} : {})})));
