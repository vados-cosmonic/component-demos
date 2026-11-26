// Verify both provider spellings against the published minified browser matrix.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const [checkout, output, flag, ...extra] = process.argv.slice(2);
assert(checkout && output && !extra.length && (flag === undefined || flag === "--before"));
const web = join(import.meta.dirname, "..");
const { transpileBytes } = await import(pathToFileURL(resolve(checkout, "packages/jco-transpile/dist/transpile.js")));
const matrix = JSON.parse(gunzipSync(await readFile(join(web, "bench/results/review-matrix-minified-db4a3aca0.json.gz"))));
const map = Object.fromEntries((await readFile(join(web, "host/imports.txt"), "utf8")).trim().split("\n").map(line => {
  const [name, symbol] = line.split(/\s+/);
  return [name, "../../../host/web-host.js#" + symbol];
}));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const rows = [];
for (const lang of ["c", "cpp", "rust"]) for (const demo of Object.keys(matrix.workloads)) {
  const name = demo.replaceAll("-", "_");
  const component = await readFile(join(web, lang, demo, "native", name + ".wasm"));
  const row = {lang, demo};
  for (const [label, suffix] of [["bare",""], ["slash","/"]]) {
    const { files } = await transpileBytes(component, {
      name, cmRuntimeEsModule: "@bytecodealliance/jco-cm-runtime" + suffix, minify: true,
      nodejsCompat: false, base64Cutoff: 5000, emitTypescriptDeclarations: false, namespacedExports: true, map,
    });
    const js = Buffer.from(files[name + ".js"]);
    const hashes = Object.fromEntries(Object.entries(files).map(([file, bytes]) => [file, digest(bytes)]));
    for (const [file, sha] of Object.entries(hashes)) {
      if (label === "bare" || file.endsWith(".wasm")) {
        assert.equal(sha, matrix.manifest["/" + lang + "/" + demo + "/external/" + file].sha256);
      }
    }
    row[label] = {bytes:js.length, hashes, sync:js.includes("/intrinsics/sync")};
  }
  assert(row.bare.sync);
  if (flag === "--before") assert(!row.slash.sync);
  else assert.deepEqual(row.slash, row.bare);
  rows.push(row);
}
const revision = execFileSync("git", ["rev-parse","HEAD"], {cwd:checkout, encoding:"utf8"}).trim();
await writeFile(output, JSON.stringify({revision, rows}, null, 2) + "\n");
