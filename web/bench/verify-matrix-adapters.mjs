// Check whether a later compiler emits exactly the adapters executed by a recorded matrix.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const [checkout, archive] = process.argv.slice(2);
assert(archive, "Usage: verify-matrix-adapters.mjs <built Jco checkout> <matrix.json.gz>");
const matrix = JSON.parse(gunzipSync(await readFile(archive)));
assert(matrix.minify && matrix.checkedPackage);
const web = join(import.meta.dirname, "..");
const { transpileBytes } = await import(pathToFileURL(resolve(checkout, "packages/jco-transpile/dist/transpile.js")));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const map = Object.fromEntries((await readFile(join(web, "host/imports.txt"), "utf8")).trim().split("\n").map(line => {
  const [name, symbol] = line.split(/\s+/);
  return [name, "../../../host/web-host.js#" + symbol];
}));
const entries = matrix.samples.filter(s => s.round === 0 && ["bundled", "external"].includes(s.version));
assert.equal(entries.length, 2 * 3 * Object.keys(matrix.workloads).length);
let cores = 0;
const runtime = new Set();
for (const { entry, demo, lang, version, requests } of entries) {
  const name = demo.replaceAll("-", "_");
  const component = await readFile(join(web, lang, demo, "native", name + ".wasm"));
  const { files } = await transpileBytes(component, {
    name, map, nodejsCompat: false, minify: true, base64Cutoff: 5000,
    emitTypescriptDeclarations: false, namespacedExports: true,
    ...(version === "external" && { cmRuntimeEsModule: matrix.checkedPackage }),
  });
  const dir = dirname(entry) + "/";
  assert.deepEqual(Object.keys(files).sort(), Object.keys(matrix.manifest)
    .filter(path => path.startsWith(dir)).map(path => path.slice(dir.length)).sort());
  for (const [file, bytes] of Object.entries(files)) {
    assert.equal(sha256(bytes), matrix.manifest[dir + file].sha256, dir + file);
    if (file.endsWith(".wasm")) cores++;
  }
  for (const { path } of requests) if (path.startsWith("/runtime/")) runtime.add(path);
}
for (const path of runtime) {
  const bytes = await readFile(join(checkout, "packages/jco-cm-runtime/dist", path.slice("/runtime/".length)));
  assert.equal(sha256(bytes), matrix.manifest[path].sha256, path);
}
console.log(`Matched ${entries.length} JavaScript entries, ${cores} emitted core files and ${runtime.size} served runtime files.`);
