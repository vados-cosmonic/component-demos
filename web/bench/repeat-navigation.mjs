// Compare first and repeat visits in distinct documents while independently
// caching the component JavaScript and Wasm. Validate every asset against
// the published matrix for this compiler revision.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { transpile } from "@bytecodealliance/jco";
import puppeteer from "puppeteer-core";

const [checkout, upstreamStage, matrixPath, output] = process.argv.slice(2);
assert(
  output,
  "Usage: repeat-navigation.mjs <built PR checkout> <upstream dist+vendor stage> <matrix.json.gz> <output.json.gz>",
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const matrixBytes = await readFile(matrixPath);
const matrix = JSON.parse(gunzipSync(matrixBytes));
assert(matrix.minify && matrix.checkedPackage);
const web = join(import.meta.dirname, "..");
const versions = ["release", "main", "bundled", "external"];
const policies = ["neither", "js", "wasm", "both"];
const names = { "dom-query": [8, 2], "table-update": [8] };
const sources = new Map();
const expected = new Map();
function record(path, bytes) {
  assert.equal(hash(bytes), matrix.manifest[path].sha256, path);
  sources.set(path, Buffer.from(bytes));
}
const generators = {};
for (const [mode, dir] of [
  ["main", upstreamStage],
  ["bundled", join(checkout, "packages/jco-transpile")],
]) {
  assert.equal(
    hash(await readFile(join(dir, "vendor/js-component-bindgen-component.core.wasm"))),
    matrix.compilers[mode]["js-component-bindgen-component.core.wasm"],
  );
  generators[mode] = (
    await import(pathToFileURL(resolve(dir, "dist/transpile.js")))
  ).transpileBytes;
}
const imports = Object.fromEntries(
  (await readFile(join(web, "host/imports.txt"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const [key, name] = line.split(/\s+/);
      return [key, "../../../host/web-host.js#" + name];
    }),
);
const cases = [];
for (const demo of Object.keys(names)) {
  const name = demo.replaceAll("-", "_");
  for (const lang of ["c", "cpp", "rust"]) {
    const base = "/" + lang + "/" + demo;
    const component = await readFile(join(web, base, "native", name + ".wasm"));
    for (const version of versions) {
      const opts = { name, nodejsCompat: false, map: imports, minify: true };
      if (version !== "release")
        Object.assign(opts, {
          base64Cutoff: 5000,
          namespacedExports: true,
          emitTypescriptDeclarations: false,
        });
      if (version === "external") opts.cmRuntimeEsModule = matrix.checkedPackage;
      const { files } = await (
        version === "release" ? transpile : (generators[version] ?? generators.bundled)
      )(component, opts);
      const entry = base + "/" + version + "/" + name + ".js";
      const row = matrix.samples.find((row) => row.entry === entry);
      const paths = row.requests.map((r) => r.path).sort();
      assert.equal(paths.filter((p) => p.endsWith(".wasm")).length, 1);
      for (const path of paths) {
        if (sources.has(path)) continue;
        if (path.startsWith("/runtime/"))
          record(
            path,
            await readFile(join(checkout, "packages/jco-cm-runtime/dist", path.slice(9))),
          );
        else record(path, files[basename(path)]);
      }
      expected.set(entry, paths);
    }
    cases.push({ base, name, demo });
  }
}
for (const path of [
  "/host/common.js",
  "/host/web-host.js",
  ...Object.keys(names).map((d) => "/examples/" + d + "/main.js"),
]) {
  record(path, await readFile(join(web, path)));
}

async function measure({ prefix, demo, entry, args }) {
  const { getMeasurements } = await import(prefix + "/examples/" + demo + "/main.js");
  await import(prefix + "/host/web-host.js");
  performance.clearResourceTimings();
  const start = performance.now();
  const { run } = await import(prefix + entry);
  const ready = performance.now();
  run(...args);
  const end = performance.now();
  const reports = Object.values(getMeasurements());
  if (
    reports.length !== 1 ||
    Object.keys(reports[0]).length !== (demo === "dom-query" ? 3 : 6) ||
    !Object.values(reports[0]).every((v) => Number.isFinite(v) && v >= 0)
  )
    throw Error("Invalid guest report");
  return {
    loadMs: ready - start,
    firstMs: end - start,
    documentId: crypto.randomUUID(),
    requests: performance
      .getEntriesByType("resource")
      .map((r) => ({
        path: new URL(r.name).pathname.slice(prefix.length),
        transferred: r.transferSize,
        encoded: r.encodedBodySize,
      })),
  };
}
const treatments = versions.flatMap((version) => policies.map((policy) => ({ version, policy })));
const rounds = 16;
const samples = [];
const ids = new Set();
let chromium;
for (let round = 0; round < rounds; round++) {
  const queue = [];
  for (let i = 0; i < cases.length; i++) {
    const item = cases[(i + round) % cases.length];
    for (let pos = 0; pos < treatments.length; pos++) {
      // A balanced sequence makes each treatment follow every other treatment
      // once within a workload across the sixteen independent browser rounds.
      const slot = pos % 2 ? (pos + 1) / 2 : (treatments.length - pos / 2) % treatments.length;
      const treatment = treatments[(slot + round) % treatments.length];
      const entry = item.base + "/" + treatment.version + "/" + item.name + ".js";
      const prefix = "/assets/" + String(queue.length / 2).padStart(2, "0");
      for (const visit of [1, 2]) queue.push({ ...item, ...treatment, entry, pos, prefix, visit });
    }
  }
  const gate = Promise.withResolvers(),
    done = Promise.withResolvers();
  done.promise.catch(() => {});
  let index = 0,
    network = [];
  const watchdog = setTimeout(() => done.reject(Error("Timed out on " + index)), 90000);
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      if (path === "/")
        return res
          .writeHead(200, { "Content-Type": "text/html" })
          .end('<script>fetch("/gate").then(()=>location.replace("/trial/0"))</script>');
      if (path === "/gate") {
        await gate.promise;
        return res.end();
      }
      if (path === "/favicon.ico") return res.writeHead(204).end();
      const { base, demo, entry, version, policy, prefix, pos, visit } = queue[index];
      if (path === "/trial/" + index) {
        const imports = Object.fromEntries(
          expected
            .get(entry)
            .filter((p) => p.startsWith("/runtime/"))
            .map((p) => [matrix.checkedPackage + p.slice(8, -3), prefix + p]),
        );
        const args = { prefix, demo, entry, args: names[demo] };
        return res.writeHead(200, { "Content-Type": "text/html" })
          .end(`<!doctype html><head><script type="importmap">${JSON.stringify({ imports })}</script></head><body><script type="module">
          let result;try{result=await (${measure})(${JSON.stringify(args)})}catch(e){result={error:String(e.stack||e)}}
          const next=await(await fetch("/result/${index}",{method:"POST",body:JSON.stringify(result)})).text();if(next)location.replace(next);
          </script>`);
      }
      if (path === "/result/" + index && req.method === "POST") {
        let body = "";
        for await (const part of req) body += part;
        const row = JSON.parse(body);
        assert(!row.error, row.error);
        assert(row.firstMs >= row.loadMs && row.loadMs > 0 && !ids.has(row.documentId));
        ids.add(row.documentId);
        assert.deepEqual(row.requests.map((q) => q.path).sort(), expected.get(entry));
        const observed = row.requests
          .filter((q) => q.transferred > 0)
          .map((q) => q.path)
          .sort();
        assert.deepEqual(observed, network.sort(), "Browser and server disagree about transfers");
        if (visit === 1 || policy === "neither") assert.deepEqual(observed, expected.get(entry));
        samples.push({ round, base, version, policy, pos, visit, ...row, network });
        network = [];
        watchdog.refresh();
        if (++index === queue.length) {
          res.end();
          done.resolve();
        } else res.end("/trial/" + index);
        return;
      }
      assert(path.startsWith(prefix + "/"), path);
      const asset = path.slice(prefix.length);
      const bytes = sources.get(asset);
      assert(bytes, asset);
      if (expected.get(entry).includes(asset)) {
        network.push(asset);
        const kind = asset.endsWith(".wasm") ? "wasm" : "js";
        if (policy === "both" || policy === kind)
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
      res
        .writeHead(200, {
          "Content-Type": asset.endsWith(".wasm") ? "application/wasm" : "text/javascript",
        })
        .end(bytes);
    } catch (error) {
      res.writeHead(500).end();
      done.reject(error);
    }
  });
  let browser, endpoint;
  try {
    await new Promise((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
    browser = await puppeteer.launch({
      executablePath: process.env.CHROME_BIN,
      args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [],
    });
    chromium = await browser.version();
    await (await browser.newPage()).goto("http://127.0.0.1:" + server.address().port);
    endpoint = browser.wsEndpoint();
    await browser.disconnect();
    gate.resolve();
    await done.promise;
  } finally {
    clearTimeout(watchdog);
    gate.resolve();
    try {
      if (endpoint) browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
      await browser?.close();
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }
  console.log("Completed", round + 1, "of", rounds, "browser rounds");
}
await writeFile(
  output,
  gzipSync(
    JSON.stringify({
      rounds,
      chromium,
      versions,
      policies,
      inputs: names,
      release: matrix.release,
      upstream: matrix.upstream,
      candidate: matrix.candidate,
      matrixSha256: hash(matrixBytes),
      runnerSha256: hash(await readFile(import.meta.filename)),
      samples,
    }),
  ),
);
