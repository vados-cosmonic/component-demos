// Measure one JS-to-guest call that calls the host and returns. A guest import
// keeps this export on the task-managed path even though its signature is flat.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { parse, transpile } from "@bytecodealliance/jco";
import puppeteer from "puppeteer-core";

const [before, after, runtime, output] = process.argv.slice(2);
assert(output, "Usage: export-task-register.mjs <before-transpiler-dir> <after-transpiler-dir> <runtime-dist> <output.json.gz>");
const component = await parse(`(component
  (import "step" (func $step (param "n" u32) (result u32)))
  (core func $lower (canon lower (func $step)))
  (core module $guest (import "" "step" (func $step (param i32) (result i32)))
    (func (export "run") (param i32) (result i32) (call $step (local.get 0))))
  (core instance $i (instantiate $guest (with "" (instance (export "step" (func $lower))))))
  (func (export "run") (param "n" u32) (result u32) (canon lift (core func $i "run"))))`);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const provider = "@bytecodealliance/jco-cm-runtime", assets = new Map(), imports = {};
for (const file of await readdir(runtime, {recursive:true})) {
  if (file.endsWith(".js") && !file.startsWith("debug/")) {
    const path = "/runtime/" + file;
    assets.set(path, await readFile(join(runtime,file)));
    imports[provider+"/"+file.slice(0,-3)] = path;
  }
}
const modes = ["direct", "release"], compilers = {}, sizes = {};
const options = {name:"task", minify:true, instantiation:"async", nodejsCompat:false, emitTypescriptDeclarations:false, base64Cutoff:0};
const coreFile = "task.core.wasm";
const release = (await transpile(component,options)).files;
assets.set("/release/task.js",Buffer.from(release["task.js"]));
const core = Buffer.from(release[coreFile]).toString("base64");
for (const [revision, dir] of [["before",before],["after",after]]) {
  const {transpileBytes} = await import(pathToFileURL(resolve(dir,"dist/transpile.js")));
  compilers[revision] = hash(await readFile(join(dir,"vendor/js-component-bindgen-component.core.wasm")));
  for (const build of ["internal","external"]) {
    const mode = revision+"-"+build;
    const opts = build === "external" ? {...options,cmRuntimeEsModule:provider} : options;
    const {files} = await transpileBytes(component,opts);
    assert.deepEqual(Object.keys(files).sort(), [coreFile,"task.js"]);
    assert.equal(Buffer.from(files[coreFile]).toString("base64"),core);
    const bytes = Buffer.from(files["task.js"]);
    assets.set("/"+mode+"/task.js",bytes);
    sizes[mode] = {bytes:bytes.length,gzip:gzipSync(bytes).length,sha256:hash(bytes)};
    modes.push(mode);
  }
}
const rounds = 18, count = 2048, samples = [], allocations = [];
const browser = await puppeteer.launch({executablePath:process.env.CHROME_BIN,pipe:true,
  args:process.env.CHROME_NO_SANDBOX==="1"?["--no-sandbox"]:[]});
try {
  for (let round=0; round<rounds; round++) {
    const page = await browser.newPage();
    try {
      await page.setRequestInterception(true);
      page.on("request", req => {
        const p = new URL(req.url()).pathname;
        if (p === "/") return req.respond({contentType:"text/html",headers:{
          "Cross-Origin-Opener-Policy":"same-origin","Cross-Origin-Embedder-Policy":"require-corp"},
          body:'<!doctype html><script type="importmap">'+JSON.stringify({imports})+'</script>'});
        const bytes = assets.get(p);
        return bytes ? req.respond({contentType:"text/javascript",body:bytes}) : req.abort();
      });
      await page.goto("https://bench.test/");
      const result = await page.evaluate(async ({core,round,count,modes}) => {
        const mod = await WebAssembly.compile(Uint8Array.fromBase64(core));
        const step = n => n+1, fns = {}, globals = {};
        for (let i=0;i<modes.length;i++) {
          const mode=modes[(i+round)%modes.length];
          if(mode==="direct"){
            fns[mode]=(await WebAssembly.instantiate(mod,{"":{step}})).exports.run;
            continue;
          }
          const {instantiate}=await import("/"+mode+"/task.js");
          // Only interpose on a separate instance. Timed instances always see
          // the native Global constructor, including during initialization.
          const NativeGlobal=WebAssembly.Global;
          globals[mode]=0;
          WebAssembly.Global=new Proxy(NativeGlobal,{construct(target,args,newTarget){
            globals[mode]++;
            return Reflect.construct(target,args,newTarget);
          }});
          try {
            const check=await instantiate(()=>mod,{step:{default:step}});
            if(check.run(5)!==6) throw Error("Incorrect guest result");
          } finally { WebAssembly.Global=NativeGlobal; }
          fns[mode]=(await instantiate(()=>mod,{step:{default:step}})).run;
        }
        const rows=[];
        const sequence=[0,1,5,2,4,3];
        for(let pass=0;pass<12;pass++) for(const slot of sequence){
          const mode=modes[(slot+round+pass)%modes.length], fn=fns[mode];
          let sum=0;
          const start=performance.now();
          for(let n=0;n<count;n++) sum+=fn(n);
          const ns=(performance.now()-start)*1e6/count;
          if(sum!==count*(count+1)/2) throw Error("Incorrect checksum in "+mode);
          if(pass>=6) rows.push({round,pass,mode,ns});
        }
        return {rows,globals};
      },{core,round,count,modes});
      for (const build of ["internal","external"]) {
        assert.equal(result.globals["before-"+build],result.globals["after-"+build]+1);
      }
      samples.push(...result.rows);
      allocations.push(result.globals);
    } finally { await page.close(); }
    if ((round+1)%6===0) console.log("Completed",round+1,"of",rounds,"pages");
  }
  await writeFile(output,gzipSync(JSON.stringify({rounds,count,modes,compilers,sizes,allocations,samples,
    fixtureSha256:hash(component),coreSha256:hash(Buffer.from(core,"base64")),runnerSha256:hash(await readFile(import.meta.filename)),
    chromium:await browser.version()})));
} finally { await browser.close(); }
