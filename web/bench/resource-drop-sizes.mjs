// Measure whitespace in generated resource destructors and check the complete JS syntax tree.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { parse } from "acorn";

const [before, after, output, flag, ...extra] = process.argv.slice(2);
const unusedIntrinsics = flag === "--unused-intrinsics";
assert(output && !extra.length && (flag === undefined || unusedIntrinsics),
  "Usage: resource-drop-sizes.mjs <before-transpile> <after-transpile> <output.json> [--unused-intrinsics]");
const bench = import.meta.dirname, web = join(bench, "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const inventory = JSON.parse(await readFile(join(bench, "results/candidate-sizes.json")));
const imports = (await readFile(join(web, "host/imports.txt"), "utf8")).trim().split("\n").map(line => {
  const [name, symbol] = line.split(/\s+/);
  return "--map=" + name + "=../../../host/web-host.js#" + symbol;
});
const modes = {bundled: [], external: ["--runtime=/runtime", "--cm-runtime-sync-imports"], v1: ["--runtime=/runtime"]};

async function generate(bin, guest, name, flags) {
  const dir = await mkdtemp(join(tmpdir(), "drop-format-"));
  try {
    execFileSync(resolve(bin), [guest, dir, "--name=" + name, "--no-nodejs-compat",
      "--base64-cutoff=5000", "--namespaced-exports", ...flags, ...imports], {stdio: "inherit"});
    const coreHashes = {};
    for (const f of await readdir(dir)) {
      if (f === name + ".js") continue;
      assert(f.endsWith(".wasm"), f);
      coreHashes[f] = hash(await readFile(join(dir, f)));
    }
    return {js: await readFile(join(dir, name + ".js")), coreHashes};
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}
function syntax(bytes) {
  const tree = parse(bytes.toString(), {ecmaVersion: "latest", sourceType: "module"});
  // Keep literal values and raw spellings. Only their source offsets may move.
  return JSON.stringify(tree, (key, value) => {
    if (key === "start" || key === "end") return undefined;
    return typeof value === "bigint" ? value.toString() + "n" : value;
  });
}
function checkIntrinsicChanges(before, after, path) {
  let old = before.toString();
  let updated = after.toString();
  const threadMeta = "_getGlobalCurrentThreadMeta";
  if (!updated.includes(threadMeta) && old.includes(threadMeta)) {
    assert.equal(old.split(threadMeta).length, 2, path + ": thread metadata still used");
    old = old.replace("getCurrentTaskMeta as " + threadMeta + ", ", "");
  }
  const lookup = "_jcoThreadLookupContext";
  const declaration = "const " + lookup + " = { lookup: _jcoComponentStateLookupContext, registers: CURRENT_TASK_META };\n";
  // Generic providers can still need this object, in which case its declaration
  // moves to the first operation that requests it. The declaration itself is identical.
  if (!updated.includes(declaration)) assert.equal(old.split(lookup).length, 2, path + ": live lookup removed");
  old = old.replace(declaration, "");
  updated = updated.replace(declaration, "");
  assert.equal(old === updated, true, path + ": unexpected generated code change");
}
function size(bytes) {
  return {bytes: bytes.length, gzip: gzipSync(bytes).length, sha256: hash(bytes)};
}
const rows = [];
for (const {input} of inventory.components) {
  const guest = join(web, input.path), name = basename(guest, ".wasm");
  assert.equal(hash(await readFile(guest)), input.sha256);
  for (const [mode, flags] of Object.entries(modes)) {
    const old = await generate(before, guest, name, flags);
    const updated = await generate(after, guest, name, flags);
    assert.deepEqual(updated.coreHashes, old.coreHashes);
    if (mode === "bundled") assert(updated.js.equals(old.js), input.path);
    if (!updated.js.equals(old.js)) {
      if (unusedIntrinsics) checkIntrinsicChanges(old.js, updated.js, input.path);
      else assert(syntax(updated.js) === syntax(old.js), input.path + ": changed JS syntax tree");
    }
    rows.push({path: input.path, mode, before: size(old.js), after: size(updated.js), cores: old.coreHashes});
  }
}
await writeFile(output, JSON.stringify({before: hash(await readFile(before)), after: hash(await readFile(after)), rows}, null, 2) + "\n");
for (const mode of Object.keys(modes)) {
  const affected = rows.filter(row => row.mode === mode && row.before.sha256 !== row.after.sha256);
  console.log(mode, affected.length, "changed entries");
  if (!affected.length) continue;
  for (const metric of ["bytes", "gzip"]) {
    const saved = affected.map(row => row.before[metric] - row.after[metric]).sort((a, b) => a - b);
    const middle = Math.floor(saved.length / 2);
    const median = (saved[middle] + saved[Math.floor((saved.length - 1) / 2)]) / 2;
    console.log(metric, "saved per affected entry, min / median / max", saved[0], median, saved.at(-1));
  }
}
