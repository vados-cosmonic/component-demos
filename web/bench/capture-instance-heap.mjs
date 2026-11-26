// Measure the live JS heap of initialized C table components sharing compiled Wasm.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import puppeteer from "puppeteer-core";
import { transpile } from "@bytecodealliance/jco";

const [before, priorDist, after, currentDist, entriesFile, output] = process.argv.slice(2);
assert(
  output,
  "Usage: capture-instance-heap.mjs <before compiler> <before runtime dist> <after compiler> <after runtime dist> <entry comparison.gz> <output.gz>",
);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const entryBytes = await readFile(entriesFile),
  ref = JSON.parse(gunzipSync(entryBytes));
const web = join(import.meta.dirname, ".."),
  specifier = "../../../host/web-host.js";
const checked = "@bytecodealliance/jco-cm-runtime";
const map = Object.fromEntries(
  (await readFile(join(web, "host/imports.txt"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const [key, symbol] = line.split(/\s+/);
      return [key, specifier + "#" + symbol];
    }),
);
const input = await readFile(join(web, "c/table-update/native/table_update.wasm"));
const options = {
  name: "table_update",
  map,
  minify: true,
  base64Cutoff: 5000,
  nodejsCompat: false,
  instantiation: "async",
};
const assets = new Map(),
  imports = {},
  cores = {},
  hashes = {},
  runtimeHashes = {};
for (const path of ["/host/web-host.js", "/host/common.js", "/examples/table-update/main.js"])
  assets.set(path, await readFile(join(web, path)));
function register(mode, result) {
  assert.deepEqual(result.imports, [specifier]);
  cores[mode] = [];
  for (const [file, bytes] of Object.entries(result.files)) {
    if (!/\.(wasm|js)$/.test(file)) continue;
    const path = "/" + mode + "/" + file;
    assets.set(path, Buffer.from(bytes));
    hashes[path] = sha(bytes);
    if (file.endsWith(".wasm")) cores[mode].push(file);
  }
}
register("release", await transpile(input, options));
for (const [revision, compiler, dist] of [
  ["before", before, priorDist],
  ["after", after, currentDist],
]) {
  assert.equal(
    sha(await readFile(join(compiler, "vendor/js-component-bindgen-component.core.wasm"))),
    ref.compilerHashes[revision === "before" ? 0 : 1],
  );
  const { transpileBytes } = await import(pathToFileURL(resolve(compiler, "dist/transpile.js")));
  imports[revision] = {};
  for (const file of await readdir(dist, { recursive: true })) {
    if (!file.endsWith(".js") || file.startsWith("debug/")) continue;
    const path = "/" + revision + "/runtime/" + file,
      bytes = await readFile(join(dist, file));
    assets.set(path, bytes);
    runtimeHashes[path] = sha(bytes);
    if (!file.startsWith("chunks/")) imports[revision][checked + "/" + file.slice(0, -3)] = path;
  }
  for (const mode of ["bundled", "external"]) {
    const label = revision + "-" + mode;
    register(
      label,
      await transpileBytes(input, {
        ...options,
        emitTypescriptDeclarations: false,
        namespacedExports: true,
        ...(mode === "external" ? { cmRuntimeEsModule: checked } : {}),
      }),
    );
    assert.equal(
      hashes["/" + label + "/table_update.js"],
      ref.instantiationEntries.find((x) => x.mode === mode && x.instantiation === "async")[revision]
        .sha256,
    );
  }
}
for (const mode of ["bundled", "external"]) {
  assert.deepEqual(cores["before-" + mode], cores["after-" + mode]);
  for (const f of cores["before-" + mode])
    assert.deepEqual(
      assets.get("/before-" + mode + "/" + f),
      assets.get("/after-" + mode + "/" + f),
    );
}
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path.startsWith("/page/")) {
    const mode = path.slice(6),
      revision = mode.split("-")[0];
    return res
      .writeHead(200, { "Content-Type": "text/html" })
      .end(
        '<!doctype html><script type="importmap">' +
          JSON.stringify({ imports: imports[revision] ?? {} }) +
          "</script><body>",
      );
  }
  const bytes = assets.get(path);
  if (!bytes) return res.writeHead(404).end();
  res
    .writeHead(200, {
      "Content-Type": path.endsWith(".wasm") ? "application/wasm" : "text/javascript",
    })
    .end(bytes);
});
async function prepare({ mode, files, specifier }) {
  const host = await import("/host/web-host.js");
  const { getMeasurements } = await import("/examples/table-update/main.js");
  const base = "/" + mode + "/";
  const { instantiate } = await import(base + "table_update.js");
  const modules = new Map(
    await Promise.all(
      files.map(async (file) => [file, await WebAssembly.compileStreaming(fetch(base + file))]),
    ),
  );
  const held = [];
  globalThis.addInstances = async (count) => {
    for (let i = 0; i < count; i++)
      held.push(
        await instantiate(
          (file) => {
            if (!modules.has(file)) throw Error(file);
            return modules.get(file);
          },
          { [specifier]: host },
        ),
      );
  };
  globalThis.finish = async () => {
    held.at(-1).run(8);
    const reports = Object.values(getMeasurements());
    if (
      reports.length !== 1 ||
      !Object.values(reports[0]).every((n) => Number.isFinite(n) && n >= 0)
    )
      throw Error("invalid table report");
    for (const instance of held) instance._util?.stop();
    return { count: held.length, keys: Object.keys(reports[0]).sort() };
  };
}
const modes = Object.keys(cores),
  samples = [];
let browser, chromium;
try {
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BIN,
    pipe: true,
    args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [],
  });
  chromium = await browser.version();
  for (let round = 0; round < 10; round++) {
    const order = [0, 1, 4, 2, 3].map((i) => modes[(i + Math.floor(round / 2)) % 5]);
    if (round % 2) order.reverse();
    for (const mode of order) {
      const page = await browser.newPage();
      try {
        await page.goto("http://127.0.0.1:" + server.address().port + "/page/" + mode);
        await page.evaluate(prepare, { mode, files: cores[mode], specifier });
        const client = await page.createCDPSession();
        const snapshots = [];
        // Warm class definitions, Wasm imports and constructor allocation sites before
        // estimating live heap from two later populations in the same document.
        for (const count of [8, 32, 32]) {
          await page.evaluate((n) => globalThis.addInstances(n), count);
          await client.send("HeapProfiler.collectGarbage");
          snapshots.push(await client.send("Runtime.getHeapUsage"));
        }
        const { count, keys } = await page.evaluate(() => globalThis.finish());
        assert.equal(count, 72);
        const expected = ["create", "update (selected)", "clear (unselected)"].flatMap((phase) => [
          phase + ": total ms",
          phase + ": µs/row",
        ]);
        assert.deepEqual(keys, expected.sort());
        samples.push({ round, mode, keys, snapshots });
      } finally {
        await page.close();
      }
    }
  }
} finally {
  await browser?.close();
  await new Promise((ok) => server.close(ok));
}
await writeFile(
  output,
  gzipSync(
    JSON.stringify({
      entryComparison: sha(entryBytes),
      runner: sha(await readFile(import.meta.filename)),
      chromium,
      guest: sha(input),
      hashes,
      runtimeHashes,
      populations: [8, 40, 72],
      samples,
    }),
  ),
);
