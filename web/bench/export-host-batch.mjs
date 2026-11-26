// Amortize one export task over a varying number of calls to the same JS host.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import puppeteer from "puppeteer-core";
import { parse, transpile } from "@bytecodealliance/jco";

const [oldCompiler, oldRuntime, compiler, runtime, output] = process.argv.slice(2);
assert(
  output,
  "Usage: export-host-batch.mjs <previous transpiler> <previous runtime dist> <new transpiler> <new runtime dist> <output.json.gz>",
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const provider = "@bytecodealliance/jco-cm-runtime";
const component = await parse(`(component
  (import "step" (func $step (param "n" u32) (result u32)))
  (core func $lower (canon lower (func $step)))
  (core module $guest (import "" "step" (func $step (param i32) (result i32)))
    (func (export "run") (param $value i32) (param $count i32) (result i32)
      (loop $more
        (local.set $value (call $step (local.get $value)))
        (br_if $more (local.tee $count (i32.sub (local.get $count) (i32.const 1)))))
      (local.get $value)))
  (core instance $i (instantiate $guest (with "" (instance (export "step" (func $lower))))))
  (func (export "run") (param "value" u32) (param "count" u32) (result u32)
    (canon lift (core func $i "run"))))`);
const options = {
  name: "batch",
  instantiation: "async",
  nodejsCompat: false,
  base64Cutoff: 0,
  minify: true,
  emitTypescriptDeclarations: false,
};
const assets = new Map(),
  scopes = {};
const release = (await transpile(component, options)).files;
const core = Buffer.from(release["batch.core.wasm"]);
assets.set("/release/batch.js", release["batch.js"]);
const compilerHashes = {};
for (const [revision, transpiler, dir] of [
  ["before", oldCompiler, oldRuntime],
  ["after", compiler, runtime],
]) {
  const { transpileBytes } = await import(pathToFileURL(resolve(transpiler, "dist/transpile.js")));
  compilerHashes[revision] = hash(
    await readFile(join(transpiler, "vendor/js-component-bindgen-component.core.wasm")),
  );
  for (const renderer of ["internal", "external"]) {
    const mode = revision + "-" + renderer;
    const opts = renderer === "internal" ? options : { ...options, cmRuntimeEsModule: provider };
    const { files } = await transpileBytes(component, opts);
    assert.deepEqual(Buffer.from(files["batch.core.wasm"]), core);
    assets.set("/" + mode + "/batch.js", files["batch.js"]);
    if (renderer === "internal") continue;
    const imports = (scopes["/" + mode + "/"] = {});
    for (const file of await readdir(dir, { recursive: true })) {
      if (!file.endsWith(".js") || file.startsWith("debug/")) continue;
      const path = "/" + mode + "/runtime/" + file;
      assets.set(path, await readFile(join(dir, file)));
      imports[provider + "/" + file.slice(0, -3)] = path;
    }
  }
}
assert.deepEqual(assets.get("/before-external/batch.js"), assets.get("/after-external/batch.js"));
assert.notDeepEqual(
  assets.get("/before-internal/batch.js"),
  assets.get("/after-internal/batch.js"),
);
const rounds = 18,
  sizes = [1, 4, 16, 64, 256];
const modes = [
  "direct",
  "release",
  "before-internal",
  "after-internal",
  "before-external",
  "after-external",
];
const samples = [];
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_BIN,
  pipe: true,
  args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [],
});
try {
  for (let round = 0; round < rounds; round++) {
    const page = await browser.newPage();
    try {
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const path = new URL(req.url()).pathname;
        if (path === "/")
          return req.respond({
            contentType: "text/html",
            headers: {
              "Cross-Origin-Opener-Policy": "same-origin",
              "Cross-Origin-Embedder-Policy": "require-corp",
            },
            body:
              '<!doctype html><script type="importmap">' + JSON.stringify({ scopes }) + "</script>",
          });
        return assets.has(path)
          ? req.respond({ contentType: "text/javascript", body: Buffer.from(assets.get(path)) })
          : req.abort();
      });
      await page.goto("https://bench.test/");
      const rows = await page.evaluate(
        async ({ core, round, modes, sizes }) => {
          const mod = await WebAssembly.compile(Uint8Array.fromBase64(core));
          const step = (n) => n + 1,
            functions = {};
          for (const mode of modes) {
            if (mode === "direct")
              functions[mode] = (await WebAssembly.instantiate(mod, { "": { step } })).exports.run;
            else
              functions[mode] = (
                await (
                  await import("/" + mode + "/batch.js")
                ).instantiate(() => mod, { step: { default: step } })
              ).run;
          }
          const rows = [];
          // Rotate both axes. Each mode occupies each timing position once per
          // six passes for a given batch size, including on the measured passes.
          const sequence = [0, 1, 5, 2, 4, 3];
          for (let pass = 0; pass < 12; pass++) {
            for (let s = 0; s < sizes.length; s++) {
              const batchIndex = (s + round + pass) % sizes.length;
              const batch = sizes[batchIndex];
              const count = Math.max(512, 65536 / batch);
              for (let j = 0; j < modes.length; j++) {
                const mode = modes[(round + pass + batchIndex + sequence[j]) % modes.length];
                const run = functions[mode];
                let sum = 0;
                const start = performance.now();
                for (let i = 0; i < count; i++) sum += run(i, batch);
                const ns = ((performance.now() - start) * 1e6) / count;
                if (sum !== (count * (count - 1)) / 2 + count * batch)
                  throw Error("wrong guest result");
                if (pass >= 6) rows.push({ round, pass, mode, batch, count, position: j, ns });
              }
            }
          }
          return rows;
        },
        { core: core.toString("base64"), round, modes, sizes },
      );
      samples.push(...rows);
    } finally {
      await page.close();
    }
    if ((round + 1) % 6 === 0) console.log("Completed", round + 1, "of", rounds, "pages");
  }
  const manifest = Object.fromEntries([...assets].map(([path, bytes]) => [path, hash(bytes)]));
  await writeFile(
    output,
    gzipSync(
      JSON.stringify({
        rounds,
        sizes,
        modes,
        samples,
        manifest,
        coreSha256: hash(core),
        componentSha256: hash(component),
        runnerSha256: hash(await readFile(import.meta.filename)),
        compilerHashes,
        releaseVersion: JSON.parse(
          await readFile(
            new URL("../node_modules/@bytecodealliance/jco/package.json", import.meta.url),
          ),
        ).version,
        node: process.version,
        cpu: cpus()[0].model,
        chromium: await browser.version(),
      }),
    ),
  );
} finally {
  await browser.close();
}
