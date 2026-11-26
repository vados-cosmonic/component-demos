// Compare provider packaging and the two binding renderers on the same warmed DOM workload.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import puppeteer from "puppeteer-core";
import { bundleSharedProvider } from "./shared-provider.mjs";

const [checkout, output] = process.argv.slice(2);
assert(checkout && output, "Usage: paired-dom-review.mjs <built Jco checkout> <output.json.gz>");
const bench = import.meta.dirname, web = join(bench, "..");
const rounds = Number(process.env.ROUNDS ?? 16);
assert(Number.isInteger(rounds) && rounds > 0 && rounds % 4 === 0);
const matrixBytes = await readFile(join(bench, "results/review-matrix.json.gz"));
const matrix = JSON.parse(gunzipSync(matrixBytes));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
assert.equal(git("rev-parse", "HEAD"), matrix.candidate);
assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
const { transpileBytes } = await import(pathToFileURL(resolve(checkout, "packages/jco-transpile/dist/transpile.js")));
const runtime = resolve(checkout, "packages/jco-cm-runtime/dist");
const assets = new Map();
function add(path, bytes) {
  assert.equal(hash(bytes), matrix.manifest[path].sha256, path);
  assets.set(path, Buffer.from(bytes));
}
for (const name of await readdir(runtime, { recursive: true })) {
  if (name.endsWith(".js") && !name.startsWith("debug/")) add("/runtime/" + name, await readFile(join(runtime, name)));
}
const cases = [{ lang: "c", demo: "table-update" }, { lang: "rust", demo: "dom-traversal" }];
for (const path of ["host/web-host.js", "host/common.js", ...cases.map(c => "examples/" + c.demo + "/main.js")]) {
  add("/" + path, await readFile(join(web, path)));
}
const map = Object.fromEntries((await readFile(join(web, "host/imports.txt"), "utf8")).trim().split("\n").map(line => {
  const [name, symbol] = line.split(/\s+/);
  return [name, "../../../host/web-host.js#" + symbol];
}));
const scopes = {};
for (const c of cases) {
  const { lang, demo } = c, name = demo.replaceAll("-", "_"), base = "/" + lang + "/" + demo;
  c.entries = {};
  for (const version of ["release", "bundled", "external"]) {
    const dir = base + "/" + version;
    c.entries[version] = dir + "/" + name + ".js";
    if (version === "release") {
      for (const path of Object.keys(matrix.manifest).filter(p => p.startsWith(dir + "/"))) {
        add(path, await readFile(join(web, lang, demo, "jco-baseline", basename(path))));
      }
    } else {
      const bytes = await readFile(join(web, lang, demo, "native", name + ".wasm"));
      const options = { name, nodejsCompat: false, base64Cutoff: 5000, namespacedExports: true, emitTypescriptDeclarations: false, map: { ...map } };
      if (version === "external") Object.assign(options, { cmRuntimeEsModule: "/runtime", cmRuntimeSyncImports: true });
      const { files } = await transpileBytes(bytes, options);
      for (const [file, bytes] of Object.entries(files)) add(dir + "/" + file, bytes);
    }
  }
  c.entries.packed = base + "/packed/" + name + ".js";
  for (const [path, bytes] of [...assets]) {
    if (path.startsWith(base + "/external/")) assets.set(path.replace("/external/", "/packed/"), bytes);
  }
  c.args = Object.values(matrix.workloads[demo]);
}
const provider = await bundleSharedProvider(resolve(checkout), runtime, cases.map(c => assets.get(c.entries.external)));
assets.set("/runtime/shared-provider.js", provider.bytes);
// A scoped import map lets the same document use identical external adapters with
// separate runtime modules or the app's shared bundle. The timed call starts after import.
for (const c of cases) scopes[c.entries.packed.slice(0, c.entries.packed.lastIndexOf("/") + 1)] = provider.imports;
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  if (path === "/") {
    res.setHeader("Content-Type", "text/html");
    return res.end('<!doctype html><head><script type="importmap">' + JSON.stringify({ scopes }) + '</script></head><body></body>');
  }
  if (!assets.has(path)) return res.writeHead(404).end();
  res.setHeader("Content-Type", path.endsWith(".wasm") ? "application/wasm" : "text/javascript");
  res.end(assets.get(path));
});
const modes = ["release", "bundled", "external", "packed"];
const rows = [[0,1,3,2],[1,2,0,3],[2,3,1,0],[3,0,2,1]];
let browser;
try {
  await new Promise((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN, channel: process.env.CHROME_BIN ? undefined : "chrome",
    args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [] });
  const samples = [];
  for (let round = 0; round < rounds; round++) {
    for (const c of round % 2 ? cases.toReversed() : cases) {
      const page = await browser.newPage();
      try {
        await page.goto("http://127.0.0.1:" + server.address().port);
        // Rotate import order across pages. Each four-pass block then balances
        // timing position and every ordered pair of immediate predecessors.
        const first = round % 4;
        const orders = Array.from({ length: 8 }, (_, i) => rows[(first + i) % 4].map(j => modes[j]));
        const data = await page.evaluate(async ({ c, orders }) => {
          const { getMeasurements } = await import("/examples/" + c.demo + "/main.js");
          const { getTableRowValuesByName } = await import("/host/common.js");
          const guests = {};
          for (const mode of orders[0]) {
            performance.clearResourceTimings();
            guests[mode] = (await import(c.entries[mode])).run;
            const providerPaths = performance.getEntriesByType("resource").map(r => new URL(r.name).pathname).filter(p => p.startsWith("/runtime/"));
            if (mode === "packed" && (providerPaths.length !== 1 || providerPaths[0] !== "/runtime/shared-provider.js")) throw Error("Packed import map was ineffective");
            if (mode === "external" && (providerPaths.length < 2 || providerPaths.includes("/runtime/shared-provider.js"))) throw Error("External runtime was unexpectedly packed");
          }
          const samples = [];
          for (const [pass, order] of orders.entries()) {
            for (const [position, mode] of order.entries()) {
              document.body.replaceChildren();
              performance.clearMarks();
              performance.clearMeasures();
              guests[mode](...c.args);
              const reports = Object.values(getMeasurements());
              if (reports.length !== 1 || !Object.values(reports[0]).every(n => Number.isFinite(n) && n > 0)) throw Error("Invalid report");
              if (c.demo === "dom-traversal") {
                if (Number(getTableRowValuesByName(document.querySelector("table"), "nodes")[0]) !== 19531) throw Error("Wrong tree size");
              } else if (Object.keys(reports[0]).length !== 6 || document.querySelectorAll("table tr").length !== 4) throw Error("Incomplete table report");
              samples.push({ pass, position, mode, times: reports[0] });
            }
          }
          return samples;
        }, { c, orders });
        samples.push(...data.map(s => ({ round, demo: c.demo, ...s })));
      } finally { await page.close(); }
    }
    console.log("Completed paired DOM round", round + 1, "of", rounds);
  }
  await writeFile(output, gzipSync(JSON.stringify({ revision: matrix.candidate, matrixSha256: hash(matrixBytes), browser: await browser.version(),
    runnerSha256: hash(await readFile(import.meta.filename)), packerSha256: hash(await readFile(join(bench, "shared-provider.mjs"))),
    packedSha256: hash(provider.bytes), packedBytes: provider.bytes.length, rounds, modes, cases, samples })));
} finally { await browser?.close(); server.closeAllConnections(); server.close(); }
