import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { createRequire } from "node:module";
const [before, after, matrixFile, output] = process.argv.slice(2);
assert(
  output,
  "Usage: sync-task-entries.mjs <baseline compiler> <candidate compiler> <baseline matrix.gz> <output.gz>",
);
const hash = (x) => createHash("sha256").update(x).digest("hex");
const { parse } = createRequire(resolve("web/package.json"))("acorn");
const matrixBytes = await readFile(matrixFile),
  matrix = JSON.parse(gunzipSync(matrixBytes)),
  provider = matrix.checkedPackage;
const tools = await Promise.all(
  [before, after].map((path) => import(pathToFileURL(join(path, "dist/transpile.js")))),
);
const map = Object.fromEntries(
  (await readFile("web/host/imports.txt", "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const [a, b] = line.split(/\s+/);
      return [a, "../../../host/web-host.js#" + b];
    }),
);
const rows = [],
  controls = [];
for (const ref of matrix.samples.filter(
  (s) => s.round === 0 && ["bundled", "external"].includes(s.version),
)) {
  const { demo, lang, version } = ref,
    name = demo.replaceAll("-", "_");
  const opts = {
    name,
    minify: true,
    base64Cutoff: 5000,
    nodejsCompat: false,
    emitTypescriptDeclarations: false,
    namespacedExports: true,
    map,
    ...(version === "external" ? { cmRuntimeEsModule: provider } : {}),
  };
  const guest = await readFile("web/" + lang + "/" + demo + "/native/" + name + ".wasm");
  async function emit(options) {
    const [old, newer] = await Promise.all(tools.map((t) => t.transpileBytes(guest, options)));
    assert.deepEqual(Object.keys(old.files).sort(), Object.keys(newer.files).sort());
    for (const k of Object.keys(old.files))
      if (k !== name + ".js") assert.deepEqual(old.files[k], newer.files[k]);
    return [old, newer].map((build) => Buffer.from(build.files[name + ".js"]).toString());
  }
  const [a, b] = await emit(opts);
  assert.equal(hash(a), matrix.manifest[ref.entry].sha256, ref.entry);
  let exports;
  if (version === "bundled") assert.equal(a, b, "Oxc output changed for " + ref.entry);
  if (version === "external") {
    const taskImport = (src) =>
      parse(src, { ecmaVersion: "latest", sourceType: "module" }).body.filter(
        (n) => n.type === "ImportDeclaration" && n.source.value.endsWith("/intrinsics/async-task"),
      );
    assert.equal(taskImport(a).length, 1);
    assert.equal(taskImport(b).length, 0);
    exports = taskImport(a)[0]
      .specifiers.map((s) => s.imported.name)
      .sort();
    const [rawOld, rawNew] = await emit({ ...opts, minify: false });
    assert.equal(
      rawOld.replace(provider + "/intrinsics/async-task", provider + "/intrinsics/sync-task"),
      rawNew,
    );
  }
  if (!controls.length && version === "external") {
    for (const [label, extra] of [
      ["tracking", { callTracking: true }],
      ["opt-out", { cmRuntimeSyncImports: false }],
      ["custom", { cmRuntimeEsModule: "./provider", cmRuntimeSyncImports: true }],
    ]) {
      const [old, newer] = await emit({ ...opts, ...extra });
      assert.equal(old, newer);
      assert(!newer.includes("/intrinsics/sync-task"));
      controls.push({ label, sha256: hash(newer) });
    }
  }
  rows.push({
    demo,
    lang,
    version,
    before: hash(a),
    after: hash(b),
    bytes: [Buffer.byteLength(a), Buffer.byteLength(b)],
    gzip: [gzipSync(a).length, gzipSync(b).length],
    exports,
  });
}
assert.equal(rows.length, 42);
console.log(
  "embedded byte-identical",
  rows.filter((r) => r.version === "bundled" && r.before === r.after).length,
  "/21",
);
console.log(
  "external imports switched",
  rows.filter((r) => r.version === "external").length,
  "; controls",
  controls.map((x) => x.label),
);
await writeFile(
  output,
  gzipSync(
    JSON.stringify({
      matrix: hash(matrixBytes),
      runner: hash(await readFile(import.meta.filename)),
      rows,
      controls,
    }),
  ),
);
