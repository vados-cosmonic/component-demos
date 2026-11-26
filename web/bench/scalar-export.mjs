// Time a call from JS into Wasm. All renderers execute the same increment function.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, transpile } from "@bytecodealliance/jco";
import puppeteer from "puppeteer-core";
import { transpileBytes } from "./main/current/dist/transpile.js";

const { positionals, values: { calculator } } = parseArgs({ allowPositionals: true, options: { calculator: { type: "string" } } });
const [checkout, generator, output, previousRef, previousGenerator] = positionals;
assert(checkout && generator && output, "Usage: scalar-export.mjs <jco-checkout> <native-generator> <results.json> [<previous-ref> <previous-generator>] [--calculator <web-relative-component-path>]");
assert.equal(Boolean(previousRef), Boolean(previousGenerator));
const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
const previousRevision = previousRef && git("rev-parse", previousRef + "^{commit}");
if (previousRevision) git("diff", "--exit-code", previousRevision, "HEAD", "--", "packages/jco-cm-runtime/src", "packages/jco-cm-runtime/package.json");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const inventory = JSON.parse(await readFile(join(import.meta.dirname, "results/candidate-sizes.json")));
assert.equal((await readFile(join(import.meta.dirname, "main/current/commit"), "utf8")).trim(), inventory.main);
assert.equal(JSON.parse(await readFile(join(import.meta.dirname, "../node_modules/@bytecodealliance/jco/package.json"))).version, inventory.baseline);
const input = calculator ? await readFile(join(import.meta.dirname, "..", calculator)) : await parse(`(component
  (core module $guest (func (export "increment") (param i32) (result i32) (i32.add (local.get 0) (i32.const 1))))
  (core instance $i (instantiate $guest))
  (func (export "increment") (param "n" u32) (result u32) (canon lift (core func $i "increment"))))`);
if (calculator) {
  const data = inventory.components.find(c => c.input.path === calculator);
  assert.equal(hash(input), data?.input.sha256, "Calculator must match the measured input inventory");
}
const opts = { name: "scalar", instantiation: "async", nodejsCompat: false, base64Cutoff: 0 };
const files = new Map(), entries = {}, sizes = {};
let core;
function record(label, assets) {
  const bytes = Buffer.from(assets["scalar.core.wasm"]);
  core ??= bytes;
  assert.deepEqual(bytes, core);
  const entry = Buffer.from(assets["scalar.js"]);
  files.set("/" + label + "/scalar.js", entry);
  entries[label] = hash(entry);
  sizes[label] = { jsBytes: entry.length, gzipBytes: gzipSync(entry).length };
}
record("release", (await transpile(input, { ...opts })).files);
record("main", (await transpileBytes(input, { ...opts })).files);
const tmp = await mkdtemp(join(tmpdir(), "jco-export-"));
try {
  const source = join(tmp, "input.wasm");
  await writeFile(source, input);
  const builds = [[generator, ""]];
  if (previousGenerator) builds.push([previousGenerator, "previous-"]);
  for (const [binary, prefix] of builds) {
    for (const mode of ["bundled", "external"]) {
      const label = prefix + mode;
      const dir = join(tmp, label);
      const flags = mode === "external" ? ["--runtime=@bytecodealliance/jco-cm-runtime"] : [];
      execFileSync(resolve(binary), [source, dir, "--name=scalar", "--instantiation", "--no-nodejs-compat", "--base64-cutoff=0", ...flags]);
      record(label, Object.fromEntries(await Promise.all((await readdir(dir)).map(async file => [file, await readFile(join(dir, file))]))));
    }
  }
} finally { await rm(tmp, { recursive: true, force: true }); }
const runtime = join(checkout, "packages/jco-cm-runtime/dist");
for (const file of await readdir(runtime, { recursive: true })) {
  if (file.endsWith(".js") && !file.startsWith("debug/")) files.set("/runtime/" + file, await readFile(join(runtime, file)));
}
const pkg = JSON.parse(await readFile(join(runtime, "../package.json")));
const imports = Object.fromEntries(Object.entries(pkg.exports)
  .filter(([name, entry]) => name.startsWith("./") && entry.default?.startsWith("./dist/"))
  .map(([name, entry]) => [pkg.name + name.slice(1), "/runtime/" + entry.default.slice("./dist/".length)]));
const document = '<!doctype html><script type="importmap">' + JSON.stringify({ imports }) + '</script>';
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN, pipe: true,
  args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [] });
const samples = [], count = 65536;
try {
  for (let round = 0; round < 10; round++) {
    const page = await browser.newPage();
    try {
      await page.setRequestInterception(true);
      page.on("request", req => {
        const path = new URL(req.url()).pathname;
        if (path === "/") return req.respond({ contentType: "text/html", body: document });
        return files.has(path) ? req.respond({ contentType: "text/javascript", body: files.get(path) }) : req.abort();
      });
      await page.goto("https://bench.test/");
      samples.push(...await page.evaluate(async ({ core, labels, count, round, calculator }) => {
        const module = await WebAssembly.compile(Uint8Array.fromBase64(core));
        const name = calculator ? "add" : "increment";
        const funcs = { direct: (await WebAssembly.instantiate(module)).exports[name] };
        for (const label of labels) {
          const { instantiate } = await import("/" + label + "/scalar.js");
          funcs[label] = (await instantiate(() => module, {}))[name];
        }
        const names = Object.keys(funcs), rows = [];
        for (let pass = -2; pass < 5; pass++) {
          for (let i = 0; i < names.length; i++) {
            const shift = round + pass + 2;
            const mode = names[(shift + (shift % 2 ? -i : i) + names.length) % names.length];
            const fn = funcs[mode];
            let sum = 0;
            const start = performance.now();
            if (calculator) {
              for (let n = 0; n < count; n++) sum += fn(n, 1);
            } else {
              for (let n = 0; n < count; n++) sum += fn(n);
            }
            const elapsedMs = performance.now() - start;
            if (sum !== count * (count + 1) / 2) throw Error("Incorrect sum for " + mode);
            if (pass >= 0) rows.push({ round, pass, mode, elapsedMs });
          }
        }
        return rows;
      }, { core: core.toString("base64"), labels: Object.keys(entries), count, round, calculator: Boolean(calculator) }));
    } finally { await page.close(); }
  }
  await writeFile(output, JSON.stringify({ chromium: await browser.version(), revision: git("rev-parse", "HEAD"),
    main: inventory.main, release: inventory.baseline, fixture: calculator ?? "increment", componentSha256: hash(input), coreSha256: hash(core), entries, sizes, generatorSha256: hash(await readFile(generator)),
    previousRevision, previousGeneratorSha256: previousGenerator && hash(await readFile(previousGenerator)),
    runnerSha256: hash(await readFile(import.meta.filename)), count, samples }, null, 2) + "\n");
} finally { await browser.close(); }
