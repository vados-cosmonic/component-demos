// Compare the private diagnostic labels emitted for synchronous host imports.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const [before, after, oldMatrix, newMatrix, output] = process.argv.slice(2);
assert(output, "Usage: sync-import-names.mjs <old transpiler> <new transpiler> <old matrix.gz> <new matrix.gz> <output.json.gz>");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const matrixBytes = await Promise.all([oldMatrix, newMatrix].map(path => readFile(path)));
const matrices = matrixBytes.map(bytes => JSON.parse(gunzipSync(bytes)));
const [matrix, current] = matrices;
// Only the JS adapters in the two treatment arms can change. This also
// checks every runtime module, guest Wasm, release, upstream and shim asset.
const targets = new Set(matrix.samples.filter(s => s.version === "bundled" || s.version === "external").map(s => s.entry));
assert.equal(targets.size, 42);
assert.deepEqual(Object.keys(matrix.manifest).sort(), Object.keys(current.manifest).sort());
for (const [path, file] of Object.entries(matrix.manifest)) {
  if (!targets.has(path)) assert.deepEqual(current.manifest[path], file, path);
}
assert.equal(matrix.checkedPackage, current.checkedPackage);
assert.deepEqual(matrix.workloads, current.workloads);
assert.deepEqual(matrix.compilers.main, current.compilers.main);
for (const key of ["upstream", "runnerSha256", "cpu", "chromium", "minify", "rounds"]) {
  assert.equal(matrix[key], current[key], key);
}

const dirs = [before, after].map(dir => resolve(dir));
const compilers = await Promise.all(dirs.map(dir => import(pathToFileURL(join(dir, "dist/transpile.js")))));
const core = "js-component-bindgen-component.core.wasm";
for (const [i, dir] of dirs.entries()) {
  assert.equal(digest(await readFile(join(dir, "vendor", core))), matrices[i].compilers.bundled[core]);
}
const web = resolve(import.meta.dirname, "..");
const imports = (await readFile(join(web, "host/imports.txt"), "utf8")).trim().split("\n");
const mapping = Object.fromEntries(imports.map(line => {
  const [id, symbol] = line.split(/\s+/);
  return [id, "../../../host/web-host.js#" + symbol];
}));
function widths(bytes) {
  return { raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length, sha256: digest(bytes) };
}
const workloads = [];
const label = /^\s*_trampoline\d+\.fnName = '[^'\n]*';\n/gm;
for (const row of matrix.samples.filter(s => s.round === 0 && s.version === "external")) {
  const { demo, lang } = row;
  const name = demo.replaceAll("-", "_");
  const guest = await readFile(join(web, lang, demo, "native", name + ".wasm"));
  const base = { name, map: mapping, minify: true, base64Cutoff: 5000, nodejsCompat: false,
    namespacedExports: true, emitTypescriptDeclarations: false };
  const external = { cmRuntimeEsModule: matrix.checkedPackage };
  async function pair(options) {
    const builds = await Promise.all(compilers.map(c => c.transpileBytes(guest, { ...base, ...options })));
    const [a, b] = builds.map(b => b.files);
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
    const js = name + ".js";
    for (const path of Object.keys(a).filter(key => key !== js)) assert.deepEqual(a[path], b[path], path);
    return [a[js], b[js]].map(bytes => Buffer.from(bytes));
  }
  const [ordinary, changed] = (await pair({ ...external, minify: false })).map(b => b.toString());
  const removed = [...ordinary.matchAll(label)].length;
  assert(removed > 0);
  assert.equal(ordinary.replace(label, "\n").replace(/^\s*\n/gm, ""), changed.replace(/^\s*\n/gm, ""));
  const sizes = {};
  for (const [mode, opts] of [["external", external], ["bundled", {}]]) {
    const entries = (await pair(opts)).map(widths);
    for (const [i, run] of matrices.entries()) {
      const ref = run.samples.find(s => s.round === 0 && s.demo === demo && s.lang === lang && s.version === mode);
      assert.equal(entries[i].sha256, run.manifest[ref.entry].sha256);
    }
    sizes[mode] = { before: entries[0], after: entries[1] };
  }
  workloads.push({ lang, demo, removed, ...sizes });
  if (workloads.length === 1) {
    for (const options of [{ ...external, cmRuntimeSyncImports: false }, { ...external, callTracking: true },
      { cmRuntimeEsModule: "./other-provider", cmRuntimeSyncImports: true }, { runtimeProfile: "debug" }]) {
      const [a, b] = await pair(options);
      assert.deepEqual(a, b);
    }
  }
}
assert.equal(workloads.length, 21);
const summary = {
  revisions: matrices.map(run => run.candidate),
  matrices: matrixBytes.map(digest),
  runnerSha256: digest(await readFile(import.meta.filename)),
  node: process.version,
  workloads,
};
await writeFile(output, gzipSync(JSON.stringify(summary)));
for (const mode of ["bundled", "external"]) {
  for (const unit of ["raw", "gzip"]) {
    const reductions = workloads.map(row => row[mode].before[unit] - row[mode].after[unit]);
    const percentages = workloads.map((row, i) => 100 * reductions[i] / row[mode].before[unit]);
    reductions.sort((x, y) => x - y);
    percentages.sort((x, y) => x - y);
    console.log(mode, unit, "min / median / max bytes saved", reductions[0], reductions[10], reductions[20],
      "median percent", percentages[10].toFixed(2));
  }
}
