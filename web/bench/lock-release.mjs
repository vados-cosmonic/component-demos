// Measure uncontended guest lock release separately from registering and notifying waiters.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import puppeteer from "puppeteer-core";

const [matrixPath, beforeDist, afterDist, output] = process.argv.slice(2);
assert(
  output,
  "Usage: lock-release.mjs <matrix.gz> <previous runtime dist> <new runtime dist> <output.gz>",
);
const digest = (data) => createHash("sha256").update(data).digest("hex");
const matrixBytes = await readFile(matrixPath);
const matrix = JSON.parse(gunzipSync(matrixBytes));
const assets = new Map();
for (const [prefix, dist] of [
  ["/previous-runtime/", beforeDist],
  ["/runtime/", afterDist],
]) {
  for (const [path, ref] of Object.entries(matrix.manifest)) {
    if (!path.startsWith(prefix)) continue;
    const bytes = await readFile(join(dist, path.slice(prefix.length)));
    assert.equal(digest(bytes), ref.sha256, path);
    assets.set(path, bytes);
  }
}
const server = createServer((req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  if (req.url === "/")
    return res.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html>");
  if (!assets.has(req.url)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": "text/javascript" }).end(assets.get(req.url));
});

async function measure({ prefix, count }) {
  if (!crossOriginIsolated) throw Error("missing high-resolution clock");
  const [core, component, resource] = await Promise.all(
    ["core", "component", "resource"].map((name) => import(prefix + "intrinsics/" + name + ".js")),
  );
  const { RuntimeError } = WebAssembly;
  const storeTrap = component.initializeStoreTrap();
  const State = component.initializeComponentAsyncStateClass({
    RuntimeError,
    RepTable: core.initializeRepTableClass({ RuntimeError }),
    indexSpaces: resource.initializeHandleIndexSpaces(),
    instanceFlags: component.initializeInstanceFlags(),
    storeTrap,
    normalization: { RuntimeError, messages: component.initializeCoreTrapMessages({}) },
    cannotEnter: "cannot enter",
    deadlock: {
      RuntimeError,
      storeTrap,
      storeAsyncState: component.initializeStoreAsyncState(),
      asyncState: component.initializeComponentAsyncStates(),
    },
  });
  const observed = new State({ componentIdx: 0 });
  const order = [];
  const repeated = () => order.push("later");
  observed.exclusiveLock(1n);
  observed.onNextExclusiveRelease(() => {
    order.push("first");
    observed.exclusiveLock(2n);
    observed.exclusiveRelease(2n);
    order.push("returned");
  });
  observed.onNextExclusiveRelease(repeated);
  observed.onNextExclusiveRelease(repeated);
  observed.exclusiveRelease(1n);
  const state = new State({ componentIdx: 1 });
  let notified = 0;
  const notify = () => {
    notified++;
  };
  const iterations = count === 0 ? 262144 : Math.max(4096, 65536 / count);
  const ns = [];
  for (let pass = -5; pass < 5; pass++) {
    notified = 0;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      state.exclusiveLock(1n);
      for (let j = 0; j < count; j++) state.onNextExclusiveRelease(notify);
      if (!state.exclusiveRelease(1n)) throw Error("release failed");
    }
    const elapsed = performance.now() - start;
    if (notified !== iterations * count || state.isExclusivelyLocked())
      throw Error("callback count or lock mismatch");
    if (pass >= 0) ns.push((elapsed * 1e6) / iterations);
  }
  return { order, iterations, ns };
}

const counts = [0, 1, 4, 32],
  rounds = 16,
  samples = [];
let chromium;
try {
  await new Promise((resolve, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  for (let round = 0; round < rounds; round++) {
    const browser = await puppeteer.launch({
      executablePath: process.env.CHROME_BIN,
      pipe: true,
      args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [],
    });
    try {
      chromium = await browser.version();
      assert.equal(chromium, matrix.chromium);
      for (let j = 0; j < counts.length; j++) {
        const count = counts[(round + j) % counts.length];
        const modes = round % 2 ? ["after", "before"] : ["before", "after"];
        for (const [position, mode] of modes.entries()) {
          const page = await browser.newPage();
          try {
            await page.goto("http://127.0.0.1:" + server.address().port);
            const row = await page.evaluate(measure, {
              count,
              prefix: mode === "after" ? "/runtime/" : "/previous-runtime/",
            });
            const correct = ["first", "later", "later", "returned"];
            assert.deepEqual(
              row.order,
              mode === "after" ? correct : [...correct, "later", "later"],
            );
            samples.push({ round, count, mode, position, ...row });
          } finally {
            await page.close();
          }
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
await writeFile(
  output,
  gzipSync(
    JSON.stringify({
      matrixSha256: digest(matrixBytes),
      runnerSha256: digest(await readFile(import.meta.filename)),
      chromium,
      counts,
      rounds,
      samples,
    }),
  ),
);
