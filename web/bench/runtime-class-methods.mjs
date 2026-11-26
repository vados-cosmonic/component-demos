// Attribute shipped class bodies to V8 calls in unmodified, hash-checked bindings.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliCompressSync, gunzipSync, gzipSync } from "node:zlib";
import { parse } from "acorn";
import puppeteer from "puppeteer-core";

const [checkout, matrixFile, output] = process.argv.slice(2);
assert(output, "Usage: runtime-class-methods.mjs <built Jco> <matrix.gz> <results.gz>");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const matrixBytes = await readFile(matrixFile),
  matrix = JSON.parse(gunzipSync(matrixBytes));
const web = join(import.meta.dirname, "..");
const { transpileBytes } = await import(
  pathToFileURL(resolve(checkout, "packages/jco-transpile/dist/transpile.js"))
);
const map = Object.fromEntries(
  (await readFile(join(web, "host/imports.txt"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const [id, symbol] = line.split(/\s+/);
      return [id, "../../../host/web-host.js#" + symbol];
    }),
);
const assets = new Map(),
  imports = {},
  inventories = {},
  observations = [];
function add(path, bytes) {
  assert.equal(sha(bytes), matrix.manifest[path].sha256, path);
  assets.set(path, Buffer.from(bytes));
}
const builds = matrix.samples.filter(
  (s) => s.round === 0 && ["bundled", "external"].includes(s.version),
);
for (const path of [
  "/host/common.js",
  "/host/web-host.js",
  ...Object.keys(matrix.workloads).map((d) => "/examples/" + d + "/main.js"),
])
  add(path, await readFile(join(web, path)));
for (const b of builds) {
  const name = basename(b.entry, ".js");
  const guest = await readFile(join(web, b.lang, b.demo, "native", name + ".wasm"));
  const options = {
    name,
    map,
    nodejsCompat: false,
    base64Cutoff: 5000,
    namespacedExports: true,
    emitTypescriptDeclarations: false,
    minify: true,
    ...(b.version === "external" ? { cmRuntimeEsModule: matrix.checkedPackage } : {}),
  };
  const { files } = await transpileBytes(guest, options);
  for (const { path } of b.requests) {
    if (assets.has(path)) continue;
    if (path.startsWith("/runtime/")) {
      add(path, await readFile(join(checkout, "packages/jco-cm-runtime/dist", path.slice(9))));
      if (!path.startsWith("/runtime/chunks/"))
        imports[matrix.checkedPackage + "/" + path.slice(9, -3)] = path;
    } else add(path, files[basename(path)]);
  }
}
const signatures = {
  ComponentAsyncState: "waitForSyncImportCallEnd",
  AsyncTask: "validateResourceBorrowScope",
  AsyncThread: "setAwaitedCallee",
  RepTable: "contains",
};
function classes(node, found) {
  if (!node || typeof node !== "object") return;
  if (node.type === "ClassExpression" || node.type === "ClassDeclaration") {
    const publicMethods = node.body.body.filter(
      (m) => m.type === "MethodDefinition" && m.key.type === "Identifier",
    );
    const names = new Set(publicMethods.map((m) => m.key.name));
    const kind = Object.keys(signatures).find(
      (k) =>
        names.has(signatures[k]) &&
        (k !== "RepTable" || (names.has("data") && names.has("remove"))),
    );
    if (kind)
      found.push({
        kind,
        start: node.start,
        end: node.end,
        methods: publicMethods.map((m) => ({
          name: (m.kind === "get" || m.kind === "set" ? m.kind + " " : "") + m.key.name,
          start: m.start,
          body: m.value.body.start,
          end: m.end,
        })),
      });
  }
  for (const child of Object.values(node))
    if (child && typeof child === "object") classes(child, found);
}
for (const [path, bytes] of assets) {
  if (!path.endsWith(".js") || path.startsWith("/host/") || path.startsWith("/examples/")) continue;
  const found = [];
  classes(parse(bytes.toString(), { sourceType: "module", ecmaVersion: "latest" }), found);
  if (found.length) inventories[path] = found;
}
const html =
  '<!doctype html><script type="importmap">' + JSON.stringify({ imports }) + "</script><body>";
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === "/") return res.writeHead(200, { "content-type": "text/html" }).end(html);
  if (!assets.has(path)) return res.writeHead(404).end();
  res
    .writeHead(200, {
      "content-type": path.endsWith(".wasm") ? "application/wasm" : "text/javascript",
      "cache-control": "no-store",
    })
    .end(assets.get(path));
});
let browser;
try {
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BIN,
    pipe: true,
    args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [],
  });
  assert.equal(await browser.version(), matrix.chromium);
  for (const b of builds) {
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage(),
        cdp = await page.createCDPSession();
      await page.goto("http://127.0.0.1:" + server.address().port);
      await page.evaluate(async (demo) => {
        const { getMeasurements } = await import("/examples/" + demo + "/main.js");
        globalThis.readReport = getMeasurements;
        await import("/host/web-host.js");
      }, b.demo);
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
      const paths = b.requests.map((r) => r.path).filter((p) => inventories[p]);
      const entries = paths.flatMap((path) => inventories[path].map((c) => ({ path, ...c })));
      assert.deepEqual(entries.map((c) => c.kind).sort(), Object.keys(signatures).sort());
      const checkpoints = {};
      for (const stage of ["import", "guest", "stop"]) {
        if (stage === "import")
          await page.evaluate(async (entry) => {
            globalThis.guest = await import(entry);
          }, b.entry);
        if (stage === "guest") {
          const keys = await page.evaluate((args) => {
            guest.run(...args);
            const reports = Object.values(readReport());
            if (
              reports.length !== 1 ||
              !Object.values(reports[0]).every((v) => Number.isFinite(v) && v >= 0)
            )
              throw Error("invalid guest report");
            return Object.keys(reports[0]).sort();
          }, Object.values(matrix.workloads[b.demo]));
          assert.deepEqual(keys, Object.keys(b.warm).sort());
        }
        if (stage === "stop")
          await page.evaluate(async () => {
            await guest._util.whenIdle();
            guest._util.stop();
          });
        const { result } = await cdp.send("Profiler.takePreciseCoverage");
        checkpoints[stage] = {};
        for (const c of entries) {
          const script = result.find(
            (s) => s.url.startsWith("http:") && new URL(s.url).pathname === c.path,
          );
          const ranges = script?.functions.map((f) => f.ranges[0]) ?? [];
          checkpoints[stage][c.kind] = Object.fromEntries(
            c.methods.flatMap((m) => {
              const r = ranges.find(
                (r) => r.startOffset >= m.start && r.startOffset <= m.body && r.endOffset === m.end,
              );
              return r ? [[m.name, r.count]] : [];
            }),
          );
        }
      }
      observations.push({ lang: b.lang, demo: b.demo, mode: b.version, paths, checkpoints });
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  await new Promise((ok) => server.close(ok));
}

// Only methods V8 explicitly reported, with zero calls across every applicable
// document and checkpoint, qualify for the offline compressed-size estimate.
assert.equal(builds.length, 42);
const footprints = {};
const zeroMethods = {};
for (const mode of ["bundled", "external"]) {
  const documents = observations.filter((row) => row.mode === mode);
  assert.equal(documents.length, 21);
  zeroMethods[mode] = {};
  for (const kind of Object.keys(signatures)) {
    const methods = new Set(
      documents.flatMap((row) =>
        row.paths.flatMap((path) =>
          inventories[path]
            .filter((cls) => cls.kind === kind)
            .flatMap((cls) => cls.methods.map((method) => method.name)),
        ),
      ),
    );
    zeroMethods[mode][kind] = [...methods]
      .filter((name) =>
        documents.every((row) => {
          // V8 resets counters at each checkpoint and may omit a function from later
          // snapshots. Require an explicit zero in each document and no positive count.
          const counts = Object.values(row.checkpoints).flatMap((stage) =>
            Object.hasOwn(stage[kind], name) ? [stage[kind][name]] : [],
          );
          return counts.length > 0 && counts.every((count) => count === 0);
        }),
      )
      .sort();
  }
}
for (const [path, cs] of Object.entries(inventories)) {
  const users = observations.filter((o) => o.paths.includes(path));
  if (!users.length) continue;
  const source = assets.get(path).toString(),
    ranges = [];
  for (const c of cs)
    for (const m of c.methods) {
      assert(users.every((row) => row.mode === users[0].mode));
      if (zeroMethods[users[0].mode][c.kind].includes(m.name)) ranges.push(m);
    }
  let changed = source;
  for (const m of ranges.sort((a, b) => b.body - a.body))
    changed = changed.slice(0, m.body) + "{}" + changed.slice(m.end);
  const size = (code) => [Buffer.byteLength(code), brotliCompressSync(code).length];
  footprints[path] = {
    original: size(source),
    emptyBodies: size(changed),
    explicitZeros: ranges.length,
  };
}
await writeFile(
  output,
  gzipSync(
    JSON.stringify({
      candidate: matrix.candidate,
      matrixSha256: sha(matrixBytes),
      runnerSha256: sha(await readFile(import.meta.filename)),
      chromium: matrix.chromium,
      zeroMethods,
      inventories,
      observations,
      footprints,
    }),
  ),
);
