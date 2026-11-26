// Isolate resource registry code from the rest of the generated adapter.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const [oldDir, newDir, matrixPath, output, study, ...extra] = process.argv.slice(2);
const historySets = study === "--history-sets";
const captureEntries = study === "--capture-entries";
assert(!extra.length && (!study || historySets || captureEntries));
assert(output, "Usage: resource-table-registry.mjs <before jco-transpile> <after jco-transpile> <old matrix.gz> <results.gz> [--history-sets|--capture-entries]");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const matrixBytes = await readFile(matrixPath);
const matrix = JSON.parse(gunzipSync(matrixBytes));
const web = join(import.meta.dirname, "..");
const map = Object.fromEntries((await readFile(join(web, "host/imports.txt"), "utf8")).trim().split("\n").map(line => {
  const [key, name] = line.split(/\s+/);
  return [key, "../../../host/web-host.js#" + name];
}));
const dirs = [oldDir, newDir].map(dir => resolve(dir));
const compilers = await Promise.all(dirs.map(dir => import(pathToFileURL(join(dir, "dist/transpile.js")))));
const compilerHashes = await Promise.all(dirs.map(async dir => hash(await readFile(join(dir, "vendor/js-component-bindgen-component.core.wasm")))));
assert.notEqual(...compilerHashes);
const widths = bytes => ({ bytes: bytes.length, gzip: gzipSync(bytes).length, sha256: hash(bytes) });
const registryInitializer = /^\s*const HANDLE_TABLES = _jcoInitializeHandleTables\(\);\n/gm;
const getterEntry = /STORE_TRAP\.resourceTables\.push\(\{ handles: handleTable(\d+), get captures\(\) \{ return captureTable(\d+)\.byRep\(\); \} \}\);/g;
const registryWrite = captureEntries ? getterEntry : historySets ? /^\s*handleTable(\d+)\._createdReps = new Set\(\);\n/gm : /^\s*HANDLE_TABLES\[(\d+)\] = handleTable\1;\n/gm;
const registryImport = /initializeHandleTables as _jcoInitializeHandleTables, /g;
const entries = [], instantiationEntries = [];
for (const row of matrix.samples.filter(s => s.round === 0 && s.version === "external")) {
  const { lang, demo } = row;
  const name = basename(row.entry, ".js");
  const input = await readFile(join(web, lang, demo, "native", name + ".wasm"));
  const base = { name, nodejsCompat: false, map, base64Cutoff: 5000, emitTypescriptDeclarations: false, namespacedExports: true };
  const external = { cmRuntimeEsModule: matrix.checkedPackage };
  async function pair(options) {
    const builds = await Promise.all(compilers.map(c => c.transpileBytes(input, { ...base, ...options })));
    const [a,b] = builds.map(b => b.files);
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
    for (const key of Object.keys(a)) if (key !== name + ".js") assert.deepEqual(a[key], b[key], key);
    return [a,b].map(files => Buffer.from(files[name + ".js"]));
  }
  const [before, after] = (await pair(external)).map(bytes => bytes.toString());
  const writes = [...before.matchAll(registryWrite)].map(m => Number(m[1]));
  assert(writes.length > 0 && new Set(writes).size === writes.length);
  let stripped = captureEntries ? before.replace(getterEntry, (_, table, resource) =>
    `STORE_TRAP.resourceTables.push(captureTable${resource});`) : before.replace(registryWrite, "");
  if (!historySets && !captureEntries) {
    assert.equal([...before.matchAll(registryInitializer)].length, 1);
    assert.equal([...before.matchAll(registryImport)].length, 1);
    stripped = stripped.replace(registryInitializer, "").replace(registryImport, "");
  }
  assert.equal(stripped.replace(/^\s*\n/gm, ""), after.replace(/^\s*\n/gm, ""), row.entry);
  const sizes = {};
  for (const [mode, options] of [["bundled", {}], ["external", external]]) {
    const [oldSize, newSize] = (await pair({ ...options, minify: true })).map(widths);
    const reference = matrix.samples.find(s => s.round === 0 && s.lang === lang && s.demo === demo && s.version === mode);
    assert.equal(oldSize.sha256, matrix.manifest[reference.entry].sha256);
    sizes[mode] = { before: oldSize, after: newSize };
    if (lang === "c" && demo === "table-update") {
      for (const instantiation of ["sync", "async"]) {
        const [a,b] = await pair({ ...options, instantiation, minify: true });
        instantiationEntries.push({ mode, instantiation, before: widths(a), after: widths(b) });
      }
    }
  }
  if (!entries.length) {
    // These providers can observe the registry or use registrations for async tasks.
    for (const opts of [{ ...external, cmRuntimeSyncImports: false }, { ...external, callTracking: true },
                        { cmRuntimeEsModule: "./custom-provider", cmRuntimeSyncImports: true }]) {
      const [a,b] = await pair(opts);
      // Grouping the table declaration and its initialization can change blank
      // lines in an unminified adapter. Preserve every executable statement.
      if (historySets) assert.equal(a.toString().replace(/^\s*\n/gm, ""), b.toString().replace(/^\s*\n/gm, ""));
      else assert.deepEqual(a,b);
      if (!captureEntries || opts.cmRuntimeSyncImports) assert(registryWrite.test(a.toString()));
      registryWrite.lastIndex = 0;
    }
  }
  entries.push({ lang, demo, writes, ...sizes });
}
assert.equal(entries.length, 21);
await writeFile(output, gzipSync(JSON.stringify({ ...(study ? {study} : {}), compilerHashes, matrix: hash(matrixBytes),
  runner: hash(await readFile(import.meta.filename)), entries, instantiationEntries })));
for (const mode of ["bundled", "external"]) {
  for (const unit of ["bytes", "gzip"]) {
    const delta = entries.map(e => e[mode].before[unit] - e[mode].after[unit]).sort((a,b) => a-b);
    console.log(mode, unit, "min/median/max saved", delta[0], delta[10], delta[20]);
  }
}
console.log(captureEntries ? "Shutdown wrappers removed across external entries:" : historySets ? "Unused Sets removed across external entries:" : "Registry writes across external entries:", entries.reduce((n,e) => n + e.writes.length, 0));
