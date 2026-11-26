// Compare the first use of compiled components and of lightweight runtime operations.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import puppeteer from "puppeteer-core";
import { transpile } from "@bytecodealliance/jco";

const [stock, trial, matrixFile, priorFile, destination] = process.argv.slice(2);
assert(
  destination,
  "Usage: class-definition-startup.mjs <stock checkout> <trial checkout> <paired matrix> <precompiled control> <output.gz>",
);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const matrixBytes = await readFile(matrixFile),
  priorBytes = await readFile(priorFile);
const matrix = JSON.parse(gunzipSync(matrixBytes)),
  prior = JSON.parse(gunzipSync(priorBytes));
assert.equal(prior.revision, matrix.candidate);
const web = join(import.meta.dirname, "..");
const files = new Map(),
  manifest = {},
  maps = { release: {} },
  guests = ["c", "cpp", "rust"];
const operations = {
  "intrinsics/core": "initializeSymbolDispose",
  "intrinsics/component": "initializeInstanceFlags",
  "intrinsics/sync-task": "initializeCurrentTaskIds",
};
const versions = [
  "release",
  "stock-internal",
  "trial-internal",
  "stock-external",
  "trial-external",
];
function add(path, bytes) {
  const data = Buffer.from(bytes);
  manifest[path] = { sha256: sha(data), bytes: data.length };
  files.set(path, data);
}
const hostSpec = "../../../host/web-host.js";
const map = Object.fromEntries(
  (await readFile(join(web, "host/imports.txt"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const [wit, js] = line.split(/\s+/);
      return [wit, hostSpec + "#" + js];
    }),
);
for (const f of ["/host/common.js", "/host/web-host.js", "/examples/table-update/main.js"]) {
  add(f, await readFile(join(web, f)));
  assert.equal(manifest[f].sha256, matrix.manifest[f].sha256);
}
const compilers = {};
for (const [kind, dir, prefix, key] of [
  ["stock", stock, "/runtime/", "bundled"],
  ["trial", trial, "/previous-runtime/", "previous"],
]) {
  maps[kind] = {};
  const compiler = join(resolve(dir), "packages/jco-transpile");
  for (const [file, expected] of Object.entries(matrix.compilers[key])) {
    const path = join(compiler, file.startsWith("dist/") ? file : "vendor/" + file);
    assert.equal(sha(await readFile(path)), expected, path);
  }
  compilers[kind] = (
    await import(pathToFileURL(join(compiler, "dist/transpile.js")))
  ).transpileBytes;
  for (const [p, ref] of Object.entries(matrix.manifest)) {
    if (!p.startsWith(prefix)) continue;
    const file = p.slice(prefix.length),
      path = "/" + kind + "/runtime/" + file;
    add(path, await readFile(join(dir, "packages/jco-cm-runtime/dist", file)));
    assert.equal(manifest[path].sha256, ref.sha256, path);
    if (!file.startsWith("chunks/"))
      maps[kind][matrix.checkedPackage + "/" + file.slice(0, -3)] = path;
  }
}
const cores = {};
for (const lang of guests) {
  const guest = await readFile(join(web, lang, "table-update/native/table_update.wasm"));
  assert.equal(sha(guest), prior.guests[lang]);
  for (const version of versions) {
    const [kind, mode] = version.split("-");
    const opts = {
      name: "table_update",
      map,
      minify: true,
      instantiation: "async",
      base64Cutoff: 5000,
      nodejsCompat: false,
    };
    const out =
      kind === "release"
        ? await transpile(guest, opts)
        : await compilers[kind](guest, {
            ...opts,
            emitTypescriptDeclarations: false,
            namespacedExports: true,
            ...(mode === "external" ? { cmRuntimeEsModule: matrix.checkedPackage } : {}),
          });
    assert.deepEqual(out.imports, [hostSpec]);
    const ref = "/" + lang + "/" + (mode === "internal" ? "bundled" : (mode ?? "release")) + "/";
    for (const [name, bytes] of Object.entries(out.files)) {
      if (name.endsWith(".wasm")) {
        assert.equal(sha(bytes), prior.manifest[ref + name].sha256);
        add("/" + lang + "/cores/" + name, bytes);
      } else if (name.endsWith(".js")) {
        if (kind !== "trial" || mode === "external")
          assert.equal(sha(bytes), prior.manifest[ref + name].sha256);
        add("/" + lang + "/" + version + "/" + name, bytes);
      }
    }
    const names = Object.keys(out.files)
      .filter((n) => n.endsWith(".wasm"))
      .sort();
    cores[lang] ??= names;
    assert.deepEqual(cores[lang], names);
  }
}
const server = createServer((req, res) => {
  if (req.url.startsWith("/page/")) {
    const kind = req.url.slice(6);
    assert(kind in maps);
    return res
      .writeHead(200, {
        "Content-Type": "text/html",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cache-Control": "no-store",
      })
      .end(
        '<!doctype html><script type="importmap">' +
          JSON.stringify({ imports: maps[kind] }) +
          "</script><body>",
      );
  }
  if (!files.has(req.url)) return res.writeHead(404).end();
  res
    .writeHead(200, {
      "Content-Type": req.url.endsWith(".wasm") ? "application/wasm" : "text/javascript",
      "Cache-Control": "no-store",
    })
    .end(files.get(req.url));
});
async function component({ lang, version, cores, hostSpec }) {
  const host = await import("/host/web-host.js"),
    { getMeasurements } = await import("/examples/table-update/main.js");
  const modules = new Map(
    await Promise.all(
      cores.map(async (file) => [
        file,
        await WebAssembly.compileStreaming(fetch("/" + lang + "/cores/" + file)),
      ]),
    ),
  );
  const start = performance.now(),
    { instantiate } = await import("/" + lang + "/" + version + "/table_update.js");
  const imported = performance.now(),
    instance = await instantiate((name) => modules.get(name), { [hostSpec]: host });
  const ready = performance.now();
  instance.run(8);
  const end = performance.now();
  const report = Object.values(getMeasurements());
  if (
    report.length !== 1 ||
    Object.keys(report[0]).length !== 6 ||
    !Object.values(report[0]).every((n) => Number.isFinite(n) && n >= 0)
  )
    throw Error("invalid guest result");
  instance._util?.stop();
  return {
    importMs: imported - start,
    instanceMs: ready - imported,
    callMs: end - ready,
    firstMs: end - start,
  };
}
async function lightweight({ kind, mod, op }) {
  const start = performance.now(),
    api = await import("/" + kind + "/runtime/" + mod + ".js");
  const result = api[op](),
    end = performance.now();
  if (
    !(
      typeof result === "symbol" ||
      (result instanceof Map && result.size === 0) ||
      (Array.isArray(result) && result.length === 0)
    )
  )
    throw Error(op);
  return { firstMs: end - start };
}
const cases = [...guests, ...Object.keys(operations)],
  rounds = 20,
  samples = [];
let chromium;
try {
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  for (let round = 0; round < rounds; round++) {
    const browser = await puppeteer.launch({
      executablePath: process.env.CHROME_BIN,
      pipe: true,
      args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [],
    });
    try {
      chromium = await browser.version();
      assert.equal(chromium, matrix.chromium);
      for (let offset = 0; offset < cases.length; offset++) {
        const name = cases[(offset + round) % cases.length],
          standalone = name in operations;
        const n = standalone ? 2 : 5;
        for (let position = 0; position < n; position++) {
          const step = [0, 1, 4, 2, 3][position],
            idx = standalone
              ? (round + position) % 2
              : (Math.floor(round / 2) + (round % 2 ? n - step : step)) % n;
          const version = standalone ? ["stock", "trial"][idx] : versions[idx],
            kind = version.split("-")[0];
          const page = await browser.newPage();
          try {
            await page.goto("http://127.0.0.1:" + server.address().port + "/page/" + kind);
            let row;
            if (standalone) {
              const c = await page.createCDPSession();
              await c.send("HeapProfiler.collectGarbage");
              const before = (await c.send("Runtime.getHeapUsage")).usedSize;
              row = await page.evaluate(lightweight, { kind, mod: name, op: operations[name] });
              await c.send("HeapProfiler.collectGarbage");
              row.retainedBytes = (await c.send("Runtime.getHeapUsage")).usedSize - before;
            } else
              row = await page.evaluate(component, {
                lang: name,
                version,
                cores: cores[name],
                hostSpec,
              });
            assert(row.firstMs > 0);
            samples.push({ round, name, position, version, ...row });
          } finally {
            await page.close();
          }
        }
      }
    } finally {
      await browser.close();
    }
    console.log("Completed class startup round", round + 1, "of", rounds);
  }
} finally {
  await new Promise((ok) => server.close(ok));
}
await writeFile(
  destination,
  gzipSync(
    JSON.stringify({
      runner: sha(await readFile(import.meta.filename)),
      patch: sha(
        await readFile(join(import.meta.dirname, "experiments/eager-class-definitions.patch")),
      ),
      matrix: sha(matrixBytes),
      prior: sha(priorBytes),
      chromium,
      rounds,
      manifest,
      samples,
    }),
  ),
);
