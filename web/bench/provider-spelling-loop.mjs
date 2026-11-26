// Compare an external adapter produced with the trailing-slash spelling before
// the fix to both current spellings and release, using the same scalar guest.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { transpile } from "@bytecodealliance/jco";
import puppeteer from "puppeteer-core";

const [checkout, previous, output] = process.argv.slice(2);
assert(checkout && previous && output, "Usage: provider-spelling-loop.mjs <built Jco checkout> <old loop output dir> <output.json.gz>");
const {transpileBytes} = await import(pathToFileURL(resolve(checkout,"packages/jco-transpile/dist/transpile.js")));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fixture = await readFile(join(import.meta.dirname,"import-loop.wat"));
const component = execFileSync("wasm-tools", ["parse","-"], {input:fixture});
const provider = "@bytecodealliance/jco-cm-runtime";
const runtime = join(checkout,"packages/jco-cm-runtime/dist");
const assets = new Map(), imports = {}, entries = {}, cores = {};
for (const file of await readdir(runtime,{recursive:true})) {
  if (!file.endsWith(".js") || file.startsWith("debug/")) continue;
  const path = "/runtime/"+file;
  assets.set(path,await readFile(join(runtime,file)));
  imports[provider+"/"+file.slice(0,-3)] = path;
}
const options = {name:"loop",instantiation:"async",minify:true,nodejsCompat:false,base64Cutoff:0};
const modes = ["before","after","release","bare"];
for (const mode of modes) {
  let files;
  if (mode === "release") files = (await transpile(component,options)).files;
  if (mode === "bare" || mode === "after") {
    files = (await transpileBytes(component,{...options,cmRuntimeEsModule:provider+(mode==="after"?"/":"")})).files;
  }
  for (const name of ["loop.js","loop.core.wasm","loop.core2.wasm"]) {
    const bytes = files ? Buffer.from(files[name]) : await readFile(join(previous,name));
    if (name.endsWith(".wasm")) {
      if (cores[name]) assert.equal(hash(bytes),cores[name]);
      cores[name] = hash(bytes);
      assets.set("/cores/"+name,bytes);
    } else {
      entries[mode] = hash(bytes);
      assets.set("/"+mode+"/loop.js",bytes);
    }
  }
}
assert.equal(entries.after,entries.bare);
assert.notEqual(entries.after,entries.before);
const browser = await puppeteer.launch({executablePath:process.env.CHROME_BIN,pipe:true,
  args:process.env.CHROME_NO_SANDBOX==="1"?["--no-sandbox"]:[]});
const samples = [], count = 65536, rounds = 16;
try {
  for (let round=0;round<rounds;round++) {
    const page = await browser.newPage();
    try {
      await page.setRequestInterception(true);
      page.on("request",request=>{
        const path = new URL(request.url()).pathname;
        if (path === "/") return request.respond({contentType:"text/html",headers:{
          "Cross-Origin-Opener-Policy":"same-origin","Cross-Origin-Embedder-Policy":"require-corp"},
          body:'<!doctype html><script type="importmap">'+JSON.stringify({imports})+'</script>'});
        const bytes = assets.get(path);
        return bytes ? request.respond({contentType:path.endsWith(".wasm")?"application/wasm":"text/javascript",body:bytes}) : request.abort();
      });
      await page.goto("https://bench.test/");
      samples.push(...await page.evaluate(async ({modes,count,round})=>{
        if (!crossOriginIsolated) throw Error("High-resolution timing requires an isolated document");
        const host = {api:{Item:class Item {}}, number:{default:n=>n&255}};
        for (const name of ["acquire","value","maybe","text","pixels","send-pixels","get-text"]) {
          host[name] = {default:()=>{throw Error("Unexpected "+name)}};
        }
        const guests = {}, modules = {};
        for (const name of ["loop.core.wasm","loop.core2.wasm"]) modules[name] = await WebAssembly.compileStreaming(fetch("/cores/"+name));
        for (let i=0;i<modes.length;i++) {
          const mode = modes[(i+round)%modes.length];
          const {instantiate} = await import("/"+mode+"/loop.js");
          guests[mode] = await instantiate(name=>modules[name],host);
        }
        const rows = [];
        for (let pass=0;pass<8;pass++) for (const slot of [0,1,3,2]) {
          const mode = modes[(slot+round+pass)%modes.length];
          const start = performance.now();
          const sum = guests[mode].numbers(count);
          const ns = (performance.now()-start)*1e6/count;
          if (sum!==count*127.5) throw Error("Invalid scalar checksum for "+mode);
          if (pass>=4) rows.push({round,pass,mode,ns});
        }
        return rows;
      },{modes,count,round}));
    } finally { await page.close(); }
  }
  await writeFile(output,gzipSync(JSON.stringify({rounds,count,samples,cores,entries,
    fixtureSha256:hash(fixture),runnerSha256:hash(await readFile(import.meta.filename)),browser:await browser.version(),
    revision:execFileSync("git",["rev-parse","HEAD"],{cwd:checkout,encoding:"utf8"}).trim()})));
} finally { await browser.close(); }
