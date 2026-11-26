// Measure each Jco build's own minify option on the same component inputs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { transpile } from "@bytecodealliance/jco";
import { transpileBytes } from "./main/current/dist/transpile.js";
import { sizes } from "./asset-sizes.mjs";

assert.equal(process.argv.length, 3, "Usage: node web/bench/minified.mjs <jco-candidate-checkout>");
const checkout = resolve(process.argv[2]);
const web = resolve(import.meta.dirname, "..");
const results = join(import.meta.dirname, "results");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const measured = await readFile(join(results, "candidate-sizes.json"));
const inventory = JSON.parse(measured);
const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
assert.equal(git("rev-parse", "HEAD"), inventory.candidate.commit);
assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
assert.equal((await readFile(join(import.meta.dirname, "main/current/commit"), "utf8")).trim(), inventory.main);
assert.equal(JSON.parse(await readFile(join(web, "node_modules/@bytecodealliance/jco/package.json"))).version, inventory.baseline);
const { transpileBytes: candidate } = await import(pathToFileURL(join(checkout, "packages/jco-transpile/dist/transpile.js")));
const map = Object.fromEntries((await readFile(join(web, "host/imports.txt"), "utf8")).trim().split("\n").map(line => {
  const [name, symbol] = line.split(/\s+/);
  return [name, `../../../host/web-host.js#${symbol}`];
}));
const components = {};
for (const { input, variants } of inventory.components) {
  const component = await readFile(join(web, input.path));
  assert.equal(hash(component), input.sha256, input.path);
  const builds = {};
  for (const [version, generate] of [["baseline", transpile], ["main", transpileBytes], ["candidate", candidate]]) {
    const options = { name: basename(input.path, ".wasm"), nodejsCompat: false, map: { ...map }, minify: true };
    if (version === "candidate") Object.assign(options, { base64Cutoff: 5000, namespacedExports: true, emitTypescriptDeclarations: false });
    const { files } = await generate(component, options);
    const names = Object.keys(files).filter(name => /\.(js|wasm)$/.test(name)).sort();
    assert.deepEqual(names, variants[version].map(asset => basename(asset.path)).sort(), input.path);
    const assets = [];
    for (const original of variants[version]) {
      const bytes = Buffer.from(files[basename(original.path)]);
      if (original.path.endsWith(".wasm")) assert.equal(hash(bytes), original.sha256, original.path);
      const path = original.path.replace(`/jco-${version}/`, `/jco-${version}-minified/`);
      await mkdir(join(web, dirname(path)), { recursive: true });
      await writeFile(join(web, path), bytes);
      assets.push(sizes(path, bytes));
    }
    builds[version + "-minified"] = assets;
  }
  components[input.path] = builds;
}
await writeFile(join(results, "minified-sizes.json"), JSON.stringify({
  sizesSha256: hash(measured), runnerSha256: hash(await readFile(import.meta.filename)), components,
}, null, 2) + "\n");
console.log(`Measured minified files for ${Object.keys(components).length} components under three Jco builds`);
