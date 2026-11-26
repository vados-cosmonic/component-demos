// Compare request graphs for the checked package before running browser trials.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import { parse } from "acorn";

const [checkout, archive, output] = process.argv.slice(2);
assert(output, "Usage: runtime-layouts.mjs <jco checkout> <matrix.json.gz> <results.json.gz>");
const matrixBytes = await readFile(archive);
const matrix = JSON.parse(gunzipSync(matrixBytes));
const pkg = resolve(checkout, "packages/jco-cm-runtime");
const manifest = JSON.parse(await readFile(join(pkg, "package.json")));
const require = createRequire(join(pkg, "package.json"));
const { rolldown, VERSION } = await import(pathToFileURL(require.resolve("rolldown")));
const hash = value => createHash("sha256").update(value).digest("hex");
const input = Object.fromEntries(Object.entries(manifest.exports)
  .filter(([name]) => !name.startsWith("./debug"))
  .map(([name, entry]) => [name === "." ? "index" : name.slice(2),
    join(pkg, "dist/debug", entry.default.slice("./dist/".length))]));
const entries = Object.keys(input).map(name => name + ".js");
const workloads = matrix.samples.filter(row => row.round === 0 && row.version === "external");
assert.equal(workloads.length, 21);
const layouts = {};
const treatments = [
  ["shipped", null],
  ["common", { name: "common", minShareCount: 4 }],
  ...[0, 1024, 16384, 65536].map(bytes => ["aware-" + bytes, {
    name: "common", minShareCount: 4, entriesAware: true, entriesAwareMergeThreshold: bytes,
  }]),
  ["component-state", { name: "shared", test: /\/intrinsics\/component\// }],
  ["compact-helpers", { name: "shared", test: /\/intrinsics\/(?:decode-utf8|sync-waiter|js-helper)\.js$/ }],
];
const web = resolve(import.meta.dirname, "..");
const map = Object.fromEntries((await readFile(join(web, "host/imports.txt"), "utf8")).trim().split("\n").map(line => {
  const [name, symbol] = line.split(/\s+/);
  return [name, "../../../host/web-host.js#" + symbol];
}));
const { transpileBytes } = await import(pathToFileURL(resolve(checkout, "packages/jco-transpile/dist/transpile.js")));
const directImports = {};
for (const row of workloads) {
  const name = basename(row.entry, ".js");
  const guest = await readFile(join(web, row.lang, row.demo, "native", name + ".wasm"));
  const { files } = await transpileBytes(guest, { name, map, minify: true, nodejsCompat: false,
    base64Cutoff: 5000, namespacedExports: true, emitTypescriptDeclarations: false, cmRuntimeEsModule: matrix.checkedPackage });
  const bytes = files[name + ".js"];
  assert.equal(hash(bytes), matrix.manifest[row.entry].sha256);
  // A public entry might also be a transitive import in the shipped package.
  // Start alternative graphs at only the specifiers named by the adapter.
  const ast = parse(Buffer.from(bytes).toString("utf8"), { ecmaVersion: "latest", sourceType: "module" });
  directImports[row.entry] = ast.body.filter(node => node.type === "ImportDeclaration")
    .map(node => node.source.value).filter(spec => spec.startsWith(matrix.checkedPackage + "/"))
    .map(spec => spec.slice(matrix.checkedPackage.length + 1) + ".js");
  assert(directImports[row.entry].every(root => entries.includes(root)));
}
let api;
for (const [name, group] of treatments) {
  const bundle = await rolldown({
    input, platform: "neutral", external: [/^node:/], preserveEntrySignatures: "strict",
    transform: { dropLabels: ["DEBUG"] },
  });
  try {
    const { output: built } = await bundle.generate({
      format: "esm", minify: true, sourcemap: true, entryFileNames: "[name].js",
      chunkFileNames: "chunks/[name]-[hash].js",
      ...(group && { codeSplitting: { groups: [group] } }),
    });
    const chunks = new Map(built.filter(item => item.type === "chunk").map(item => [item.fileName, item]));
    const names = Object.fromEntries(entries.map(file => [file, chunks.get(file).exports.toSorted()]));
    if (!api) api = names;
    else assert.deepEqual(names, api);
    const files = {};
    for (const [path, chunk] of chunks) {
      files[path] = { bytes: Buffer.byteLength(chunk.code), gzip: gzipSync(chunk.code).length,
        imports: chunk.imports.filter(dep => chunks.has(dep)), sha256: hash(chunk.code) };
      if (name === "shipped") assert.equal(files[path].sha256, matrix.manifest["/runtime/" + path].sha256);
    }
    function footprint(roots) {
      const used = new Set(roots);
      for (const path of used) for (const child of files[path].imports) used.add(child);
      const paths = [...used].sort();
      return { paths, bytes: paths.reduce((n, p) => n + files[p].bytes, 0),
        gzip: paths.reduce((n, p) => n + files[p].gzip, 0) };
    }
    const standalone = Object.fromEntries(entries.map(file => [file, footprint([file])]));
    const demos = {};
    for (const row of workloads) {
      const paths = row.requests.filter(q => q.path.startsWith("/runtime/")).map(q => q.path.slice(9));
      const roots = directImports[row.entry];
      const graph = footprint(roots);
      if (name === "shipped") assert.deepEqual(paths.toSorted(), graph.paths);
      demos[row.lang + "/" + row.demo] = graph;
    }
    layouts[name] = { group: group && { ...group, test: group.test?.source }, files, standalone, demos };
  } finally {
    await bundle.close();
  }
}
await writeFile(output, gzipSync(JSON.stringify({ revision: matrix.candidate, matrixSha256: hash(matrixBytes),
  runnerSha256: hash(await readFile(import.meta.filename)), rolldown: VERSION, api, directImports, layouts })));
console.log("| Layout | Runtime requests per demo | Runtime gzip KiB per demo | Conversion bytes | Largest standalone increase (bytes) |");
console.log("| --- | ---: | ---: | ---: | ---: |");
for (const [name, layout] of Object.entries(layouts)) {
  const demos = Object.values(layout.demos);
  const requests = demos.map(demo => demo.paths.length);
  const gzipKiB = demos.map(demo => demo.gzip / 1024);
  const excess = entries.map(entry => layout.standalone[entry].bytes - layouts.shipped.standalone[entry].bytes);
  console.log("|", [name, Math.min(...requests) + "–" + Math.max(...requests),
    Math.min(...gzipKiB).toFixed(2) + "–" + Math.max(...gzipKiB).toFixed(2),
    layout.standalone["intrinsics/conversion.js"].bytes, Math.max(...excess)].join(" | "), "|");
}
