// Compare candidate task entry layouts using identical package sources and generated adapters.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliCompressSync, gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
const [checkout, compiler, matrixFile, output] = process.argv.slice(2);
assert(
  output,
  "Usage: sync-task-layouts.mjs <baseline checkout> <baseline jco-transpile> <baseline matrix.gz> <output.gz>",
);
const web = resolve("web"),
  pkg = join(checkout, "packages/jco-cm-runtime");
const require = createRequire(join(pkg, "package.json")),
  { rolldown } = await import(pathToFileURL(require.resolve("rolldown")));
const { parse } = createRequire(join(web, "package.json"))("acorn");
const sha = (v) => createHash("sha256").update(v).digest("hex");
const matrixBytes = await readFile(matrixFile),
  matrix = JSON.parse(gunzipSync(matrixBytes));
const input = Object.fromEntries(
  Object.entries(JSON.parse(await readFile(join(pkg, "package.json"))).exports)
    .filter(([k]) => !k.startsWith("./debug"))
    .map(([k, v]) => [
      k === "." ? "index" : k.slice(2),
      join(pkg, "dist/debug", v.default.slice(7)),
    ]),
);
const { transpileBytes } = await import(pathToFileURL(join(compiler, "dist/transpile.js")));
const map = Object.fromEntries(
  (await readFile(join(web, "host/imports.txt"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const [id, n] = line.split(/\s+/);
      return [id, "../../../host/web-host.js#" + n];
    }),
);
const asyncRoot = "intrinsics/async-task",
  syncRoot = "intrinsics/sync",
  extraRoot = "intrinsics/sync-task";
const entries = [],
  closures = {},
  controls = {},
  taskNames = new Set();
for (const row of matrix.samples.filter((s) => s.round === 0 && s.version === "external")) {
  const name = row.demo.replaceAll("-", "_");
  const guest = await readFile(join(web, row.lang, row.demo, "native", name + ".wasm"));
  const { files } = await transpileBytes(guest, {
    name,
    map,
    minify: true,
    base64Cutoff: 5000,
    nodejsCompat: false,
    namespacedExports: true,
    emitTypescriptDeclarations: false,
    cmRuntimeEsModule: matrix.checkedPackage,
  });
  const code = files[name + ".js"];
  assert.equal(sha(code), matrix.manifest[row.entry].sha256);
  const spec = parse(Buffer.from(code).toString(), {
    ecmaVersion: "latest",
    sourceType: "module",
  }).body.filter(
    (n) => n.type === "ImportDeclaration" && n.source.value.startsWith(matrix.checkedPackage + "/"),
  );
  const imports = Object.fromEntries(
    spec.map((n) => [
      n.source.value.slice(matrix.checkedPackage.length + 1),
      n.specifiers.map((s) => s.imported.name),
    ]),
  );
  for (const n of imports[asyncRoot]) taskNames.add(n);
  entries.push({ key: row.lang + "/" + row.demo, hash: sha(code), imports });
}
const taskExports =
  'export {createNewCurrentImplicitThread,getCurrentTask} from "./async-task/task-operations.js";\nexport {initializeAsyncTaskClass} from "./async-task/async-task.js";\nexport {initializeAsyncThreadClass} from "./async-task/async-thread.js";\nexport {initializeCurrentComponentIdxs,initializeCurrentTaskIds,initializeTasksByComponent} from "./async-task/initializers.js";';
const select = (entry, layout) => {
  if (layout === "existing") return entry;
  if (layout === "extend" && (entry === asyncRoot || entry === syncRoot)) return syncRoot;
  if (entry === asyncRoot || (layout === "combined" && entry === syncRoot)) return extraRoot;
  return entry;
};
for (const layout of ["existing", "separate", "extend", "combined"]) {
  const extraFile = join(pkg, "dist/debug", extraRoot + ".js");
  const entryFile = layout === "extend" ? input[syncRoot] : extraFile;
  const base =
    layout === "extend"
      ? await readFile(entryFile, "utf8")
      : layout === "combined"
        ? 'export * from "./sync.js";\n'
        : "";
  const bundle = await rolldown({
    input:
      layout === "existing" || layout === "extend" ? input : { ...input, [extraRoot]: extraFile },
    platform: "neutral",
    external: [/^node:/],
    preserveEntrySignatures: "strict",
    transform: { dropLabels: ["DEBUG"] },
    plugins:
      layout === "existing"
        ? []
        : [
            {
              name: "task-entry",
              resolveId(id) {
                if (id === entryFile) return id;
              },
              load(id) {
                if (id === entryFile) return base + "\n" + taskExports;
              },
            },
          ],
  });
  try {
    const { output } = await bundle.generate({
      format: "esm",
      minify: true,
      sourcemap: true,
      entryFileNames: "[name].js",
      chunkFileNames: "chunks/[name]-[hash].js",
      codeSplitting: {
        groups: [
          {
            name: "shared",
            test: /[/\\]intrinsics[/\\](?:decode-utf8|sync-waiter|js-helper)\.js$/,
          },
        ],
      },
    });
    const chunks = new Map(output.filter((c) => c.type === "chunk").map((c) => [c.fileName, c]));
    const sizes = new Map(
      [...chunks].map(([name, chunk]) => [
        name,
        {
          bytes: Buffer.byteLength(chunk.code),
          brotli: brotliCompressSync(chunk.code).length,
        },
      ]),
    );
    function footprint(roots) {
      const names = new Set([...roots].map((n) => n + ".js"));
      for (const n of names)
        for (const child of chunks.get(n).imports) if (chunks.has(child)) names.add(child);
      const list = [...names].sort();
      return {
        modules: list.length,
        bytes: list.reduce((n, x) => n + sizes.get(x).bytes, 0),
        brotli: list.reduce((n, x) => n + sizes.get(x).brotli, 0),
        list,
      };
    }
    closures[layout] = {};
    // Check the baseline rebuild against the actual published runtime before
    // comparing changes caused by adding or extending an entry point.
    for (const [path, chunk] of chunks) {
      if (layout === "existing") {
        const ref = matrix.manifest["/runtime/" + path];
        assert.ok(ref, path);
        assert.equal(sha(chunk.code), ref.sha256, path);
      }
    }
    for (const entry of entries) {
      for (const [path, names] of Object.entries(entry.imports))
        for (const n of names)
          assert.ok(chunks.get(select(path, layout) + ".js").exports.includes(n), path + "#" + n);
      const roots = Object.keys(entry.imports).map((n) => select(n, layout)),
        key = [...new Set(roots)].sort().join("|");
      closures[layout][key] ??= footprint(roots);
      entry[layout] = key;
    }
    controls[layout] = Object.fromEntries(Object.keys(input).map((n) => [n, footprint([n])]));
    const { modules, bytes, brotli } = closures[layout][entries[0][layout]];
    console.log(layout, modules, "modules", bytes, "raw bytes", brotli, "Brotli bytes");
  } finally {
    await bundle.close();
  }
}
await writeFile(
  output,
  gzipSync(
    JSON.stringify({
      matrixSha256: sha(matrixBytes),
      runnerSha256: sha(await readFile(import.meta.filename)),
      taskNames: [...taskNames].sort(),
      entries,
      closures,
      controls,
    }),
  ),
);
