// Check whether merging package entry wrappers into shared chunks preserves the
// runtime's public ES module namespaces on the same checked JS as the browser run.
import assert from "node:assert/strict";
import { parse } from "acorn";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const [checkout, matrixPath] = process.argv.slice(2);
assert(matrixPath, "Usage: runtime-entry-signatures.mjs <built Jco checkout> <matrix.json.gz>");
const matrix = JSON.parse(gunzipSync(await readFile(matrixPath)));
const pkg = resolve(checkout, "packages/jco-cm-runtime");
const manifest = JSON.parse(await readFile(join(pkg, "package.json")));
const require = createRequire(join(pkg, "package.json"));
const { rolldown, VERSION } = await import(pathToFileURL(require.resolve("rolldown")));
const input = Object.fromEntries(
  Object.entries(manifest.exports)
    .filter(([key]) => !key.startsWith("./debug"))
    .map(([key, value]) => [
      key === "." ? "index" : key.slice(2),
      join(pkg, "dist/debug", value.default.slice("./dist/".length)),
    ]),
);
const publicFiles = new Set(Object.keys(input).map((key) => key + ".js"));
const rows = matrix.samples.filter((row) => row.version === "external" && row.round === 0);
assert.equal(rows.length, 21);
const root = join(import.meta.dirname, "..");
const map = Object.fromEntries(
  (await readFile(join(root, "host/imports.txt"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const [name, symbol] = line.split(/\s+/);
      return [name, "../../../host/web-host.js#" + symbol];
    }),
);
const { transpileBytes } = await import(
  pathToFileURL(resolve(checkout, "packages/jco-transpile/dist/transpile.js"))
);
const direct = new Map();
for (const row of rows) {
  const name = basename(row.entry, ".js");
  const { files } = await transpileBytes(
    await readFile(join(root, row.lang, row.demo, "native", name + ".wasm")),
    {
      name,
      map,
      minify: true,
      nodejsCompat: false,
      namespacedExports: true,
      emitTypescriptDeclarations: false,
      base64Cutoff: 5000,
      cmRuntimeEsModule: matrix.checkedPackage,
    },
  );
  const entry = files[name + ".js"];
  assert.equal(createHash("sha256").update(entry).digest("hex"), matrix.manifest[row.entry].sha256);
  const imports = parse(new TextDecoder().decode(entry), {
    sourceType: "module",
    ecmaVersion: "latest",
  })
    .body.filter((node) => node.type === "ImportDeclaration")
    .map((node) => node.source.value)
    .filter((id) => id.startsWith(matrix.checkedPackage + "/"))
    .map((id) => id.slice(matrix.checkedPackage.length + 1) + ".js");
  assert(imports.length && imports.every((id) => publicFiles.has(id)));
  direct.set(row.entry, imports);
}
const api = {};
console.log("Rolldown", VERSION);
for (const signature of ["strict", "allow-extension"]) {
  const bundle = await rolldown({
    input,
    platform: "neutral",
    external: [/^node:/],
    transform: { dropLabels: ["DEBUG"] },
    preserveEntrySignatures: signature,
  });
  try {
    const { output } = await bundle.generate({
      format: "esm",
      minify: true,
      sourcemap: true,
      entryFileNames: "[name].js",
      chunkFileNames: "chunks/[name]-[hash].js",
    });
    const modules = new Map(output.filter((c) => c.type === "chunk").map((c) => [c.fileName, c]));
    if (signature === "strict") {
      for (const [path, chunk] of modules) {
        assert.equal(chunk.code, await readFile(join(pkg, "dist", path), "utf8"), path);
        assert.equal(
          createHash("sha256").update(chunk.code).digest("hex"),
          matrix.manifest["/runtime/" + path].sha256,
          path,
        );
      }
    }
    const names = (api[signature] = {});
    for (const path of publicFiles) names[path] = modules.get(path).exports.toSorted();
    const counts = [],
      sizes = [];
    for (const row of rows) {
      const used = row.requests
        .map((r) => r.path)
        .filter((p) => p.startsWith("/runtime/"))
        .map((p) => p.slice(9));
      const pending = new Set(direct.get(row.entry));
      for (const path of pending)
        for (const dependency of modules.get(path).imports) {
          if (modules.has(dependency)) pending.add(dependency);
        }
      if (signature === "strict") assert.deepEqual([...pending].sort(), used.sort(), row.entry);
      counts.push(pending.size);
      sizes.push([...pending].reduce((sum, p) => sum + Buffer.byteLength(modules.get(p).code), 0));
    }
    console.log(
      signature,
      "runtime requests",
      Math.min(...counts),
      "to",
      Math.max(...counts),
      "runtime JS bytes",
      Math.min(...sizes),
      "to",
      Math.max(...sizes),
    );
  } finally {
    await bundle.close();
  }
}
for (const path of publicFiles) {
  const before = api.strict[path],
    after = api["allow-extension"][path];
  const added = after.filter((k) => !before.includes(k)),
    removed = before.filter((k) => !after.includes(k));
  if (added.length || removed.length) console.log(path, "added", added, "removed", removed);
}
