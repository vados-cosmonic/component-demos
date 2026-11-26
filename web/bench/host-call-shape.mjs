import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, gunzipSync, brotliCompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const [checkout, matrixFile, output] = process.argv.slice(2);
assert(output, "Usage: host-call-shape.mjs <built Jco> <matrix.gz> <result.gz>");
const matrixBytes = await readFile(matrixFile);
const sha = (data) => createHash("sha256").update(data).digest("hex");
const pkg = resolve(checkout, "packages/jco-transpile"),
  { minify } = createRequire(join(pkg, "package.json"))("oxc-minify");
const { transpileBytes } = await import(pathToFileURL(join(pkg, "dist/transpile.js")));
const matrix = JSON.parse(gunzipSync(matrixBytes));
const map = Object.fromEntries(
  (await readFile("web/host/imports.txt", "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const [id, symbol] = line.split(/\s+/);
      return [id, "../../../host/web-host.js#" + symbol];
    }),
);
const rows = [];
for (const ref of matrix.samples.filter(
  (s) => s.round === 0 && ["bundled", "external"].includes(s.version),
)) {
  const name = ref.demo.replaceAll("-", "_"),
    mode = ref.version,
    opts = {
      name,
      map,
      nodejsCompat: false,
      emitTypescriptDeclarations: false,
      namespacedExports: true,
      base64Cutoff: 5000,
      ...(mode === "external" ? { cmRuntimeEsModule: matrix.checkedPackage } : {}),
    };
  const guest = await readFile("web/" + ref.lang + "/" + ref.demo + "/native/" + name + ".wasm");
  const raw = Buffer.from((await transpileBytes(guest, opts)).files[name + ".js"]).toString();
  const options = {
    module: true,
    compress: { target: "es2019", dropLabels: mode === "external" ? ["DEBUG"] : [] },
    mangle: { keepNames: true },
  };
  const row = { name: ref.lang + "/" + ref.demo, mode };
  const trial = outlineHostCalls(raw, mode);
  row.sites = trial.sites;
  for (const [label, source] of Object.entries({ original: raw, outlined: trial.code })) {
    const { code } = await minify(name + ".js", source, options);
    const hash = sha(code);
    if (label === "original") assert.equal(hash, matrix.manifest[ref.entry].sha256);
    row[label] = {
      sha256: hash,
      bytes: Buffer.byteLength(code),
      gzip: gzipSync(code).length,
      brotli: brotliCompressSync(code).length,
    };
  }
  rows.push(row);
}
assert.equal(rows.length, 42);
await writeFile(
  output,
  gzipSync(
    JSON.stringify({
      candidate: matrix.candidate,
      matrixSha256: sha(matrixBytes),
      runnerSha256: sha(await readFile(import.meta.filename)),
      rows,
    }),
  ),
);

function outlineHostCalls(source, mode) {
  const catchBody =
    /getOrCreateAsyncState\(_jcoComponentStateLookupContext, 0\)\.markTrapped\(err\);\s*getCurrentTask\(_jcoTaskLookupContext, 0\)\?\.task\.reject\(err\);\s*throw err;/g;
  const post =
    mode === "external"
      ? /if \(STORE_TRAP\.stopped \|\| STORE_TRAP\.error !== null\) \{ getOrCreateAsyncState\(_jcoComponentStateLookupContext, 0\)\.throwIfInterrupted\(\); \}/g
      : /\(STORE_TRAP\.stopped \|\| STORE_TRAP\.error !== null\) && getOrCreateAsyncState\(_jcoComponentStateLookupContext, 0\)\.throwIfInterrupted\(\);/g;
  const cb = [...source.matchAll(catchBody)],
    pb = [...source.matchAll(post)];
  // Match just the verified single-instance sync wrapper emitted by this compiler.
  const pattern = new RegExp(
    String.raw`try\s*\{\s*(?:(ret) = )?_trackHostOperation\(_jcoComponentHostOperationContext, (\(\) => [^;]+)\);\s*\}\s*catch \(err\)\s*\{\s*` +
      catchBody.source +
      String.raw`\s*\}\s*` +
      post.source,
    "g",
  );
  const combined = [...source.matchAll(pattern)];
  if (!combined.length) return { code: source, sites: 0 };
  const code = source.replace(
    pattern,
    (_, ret, fn) => (ret ? "ret = " : "") + "jcoCallSyncHost(" + fn + ");",
  );
  return {
    code:
      code +
      "\nfunction jcoCallSyncHost(operation){let result;try{result=_trackHostOperation(_jcoComponentHostOperationContext,operation);}catch(err){" +
      cb[0][0] +
      "}" +
      pb[0][0] +
      "return result;}\n",
    sites: combined.length,
  };
}
