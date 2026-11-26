// Verify the candidate CLI's transpilation API against the bytes used by the browser trials.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

assert.equal(process.argv.length, 3, "Usage: node web/bench/verify-compile-hint.mjs <jco-checkout>");
const checkout = resolve(process.argv[2]);
const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
assert.equal(git("status", "--porcelain"), "", "Use a clean Jco checkout");
const bench = import.meta.dirname;
const web = join(bench, "..");
const results = join(bench, "results");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const inventory = JSON.parse(await readFile(join(results, "candidate-sizes.json")));
const minified = JSON.parse(await readFile(join(results, "minified-sizes.json")));
const trialBytes = await readFile(join(results, "compile-hint.json"));
const trials = JSON.parse(trialBytes);
const prefix = Buffer.from(trials.hint);
const entry = createRequire(join(checkout, "packages/jco/package.json")).resolve("@bytecodealliance/jco-transpile");
assert.equal(await realpath(entry), await realpath(join(checkout, "packages/jco-transpile/dist/index.js")),
  "The CLI must resolve the checkout's transpiler");
const { transpileBytes } = await import(pathToFileURL(entry));
const mappings = (await readFile(join(web, "host/imports.txt"), "utf8")).trim().split("\n");
const map = Object.fromEntries(mappings.map(line => {
  const [name, symbol] = line.split(/\s+/);
  return [name, `../../../host/web-host.js#${symbol}`];
}));
let modules = 0, wasm = 0, browserModules = 0;
for (const { input, variants } of inventory.components) {
  const binary = await readFile(join(web, input.path));
  assert.equal(sha(binary), input.sha256, input.path);
  for (const minify of [false, true]) {
    const { files } = await transpileBytes(binary, {
      name: basename(input.path, ".wasm"), nodejsCompat: false, map: { ...map }, minify, eagerCompile: true,
      base64Cutoff: 5000, namespacedExports: true, emitTypescriptDeclarations: false,
    });
    const expected = minify ? minified.components[input.path]["candidate-minified"] : variants.candidate;
    assert.deepEqual(Object.keys(files).filter(name => /\.(js|wasm)$/.test(name)).sort(),
      expected.map(f => basename(f.path)).sort());
    for (const f of expected) {
      const bytes = Buffer.from(files[basename(f.path)]);
      if (f.path.endsWith(".js")) {
        assert(bytes.subarray(0, prefix.length).equals(prefix), f.path);
        assert.equal(sha(bytes.subarray(prefix.length)), f.sha256, f.path);
        if (Object.hasOwn(trials.hintedSources, "/" + f.path)) {
          assert.equal(sha(bytes), trials.hintedSources["/" + f.path], f.path);
          browserModules++;
        }
        modules++;
      } else {
        assert.equal(sha(bytes), f.sha256, f.path);
        wasm++;
      }
    }
  }
}
const summary = { commit: git("rev-parse", "HEAD"), modules, wasm, browserModules,
  runnerSha256: sha(await readFile(import.meta.filename)), trialSha256: sha(trialBytes) };
assert.equal(browserModules, Object.keys(trials.hintedSources).filter(p => p.includes("/jco-candidate/")).length);
await writeFile(join(results, "compile-hint-verification.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(`Verified ${modules} entry modules, ${wasm} Wasm files and ${browserModules} browser payloads at ${summary.commit}`);
