// Compare browser host copies using the same core Wasm and pixel workload.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const bench = import.meta.dirname;
const web = join(bench, "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const inventoryBytes = await readFile(join(bench, "results/candidate-sizes.json"));
const inventory = JSON.parse(inventoryBytes);
const versions = ["direct", "baseline", "main", "candidate"];
const langs = ["c", "cpp", "rust"];
const rounds = Number(process.env.ROUNDS ?? 9);
assert(Number.isInteger(rounds) && rounds > 0);
const size = 256;
const minMs = 10;
const sources = {};
const assets = new Map();
for (const path of ["bench/canvas-host.mjs", "bench/dom-core-shim.mjs", "examples/canvas-pixels/main.js",
                    "host/common.js", "host/web-host.js"]) {
  const bytes = await readFile(join(web, path));
  sources[path] = hash(bytes);
  assets.set("/" + path, bytes);
}
const paths = {};
for (const lang of langs) {
  const { variants } = inventory.components.find(c => c.input.path === lang + "/canvas-pixels/native/canvas_pixels.wasm");
  paths[lang] = {};
  let coreSha;
  for (const version of versions.slice(1)) {
    for (const file of variants[version]) {
      const bytes = await readFile(join(web, file.path));
      assert.equal(hash(bytes), file.sha256);
      assets.set("/" + file.path, bytes);
      if (file.path.endsWith("/canvas_pixels.js")) paths[lang][version] = "/" + file.path;
      if (file.path.endsWith("/canvas_pixels.core.wasm")) {
        coreSha ??= file.sha256;
        assert.equal(file.sha256, coreSha, "Core Wasm differs by generator");
        if (version === "baseline") paths[lang].direct = "/" + file.path;
      }
    }
  }
  assert.deepEqual(Object.keys(paths[lang]).sort(), [...versions].sort());
}

async function sample(page, lang, host, round) {
  return page.evaluate(async ({ builds, host, round, size, minMs, versions }) => {
    const { getMeasurements } = await import("/examples/canvas-pixels/main.js");
    const { installPixelViews, checkCanvasPixels } = await import("/bench/canvas-host.mjs");
    if (host === "view") installPixelViews();
    const { instantiateDomGuest } = await import("/bench/dom-core-shim.mjs");
    const direct = await instantiateDomGuest(builds.direct);
    const guests = { direct };
    for (const version of versions.slice(1)) guests[version] = await import(builds[version]);
    const rows = [];
    for (let pass = 0; pass <= 4; pass++) {
      for (let i = 0; i < versions.length; i++) {
        const version = versions[(round + pass + (round % 2 ? i : versions.length - i)) % versions.length];
        document.body.replaceChildren();
        performance.clearMarks();
        performance.clearMeasures();
        guests[version].run(size, minMs);
        const [times] = Object.values(getMeasurements());
        const readUs = times["getImageData(): µs/call"] * 1e6;
        const writeUs = times["putImageData(): µs/call"] * 1e6;
        if (![readUs, writeUs].every(v => Number.isFinite(v) && v > 0)) throw Error("Missing guest timing");
        const pixelsChecked = checkCanvasPixels(size);
        if (direct.counts().liveHandles !== 0) throw Error("Direct guest leaked a resource");
        if (pass) rows.push({ pass, version, readUs, writeUs, pixelsChecked });
      }
    }
    return rows;
  }, { builds: paths[lang], host, round, size, minMs, versions });
}

const server = createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  if (path === "/") return res.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><body>");
  if (!assets.has(path)) return res.writeHead(404).end();
  res.setHeader("Content-Type", path.endsWith(".wasm") ? "application/wasm" : "text/javascript");
  res.end(assets.get(path));
});
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN,
  channel: process.env.CHROME_BIN ? undefined : "chrome", pipe: true,
  args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [] });
try {
  await new Promise((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
  const samples = [];
  for (let round = 1; round <= rounds; round++) {
    for (let i = 0; i < langs.length; i++) {
      const lang = langs[(i + round - 1) % langs.length];
      for (const host of (i + round) % 2 ? ["original", "view"] : ["view", "original"]) {
        const page = await browser.newPage();
        try {
          await page.setCacheEnabled(false);
          await page.goto("http://127.0.0.1:" + server.address().port);
          const rows = await sample(page, lang, host, round);
          samples.push(...rows.map(row => ({ round, lang, host, ...row })));
        } finally { await page.close(); }
      }
    }
    console.log(`Canvas host round ${round}/${rounds}`);
  }
  await writeFile(join(bench, "results/canvas-host.json"), JSON.stringify({
    date: new Date().toISOString(), browser: await browser.version(), cpu: cpus()[0].model,
    runnerSha256: hash(await readFile(import.meta.filename)), sizesSha256: hash(inventoryBytes),
    sources, candidate: inventory.candidate, rounds, passes: 4, size, minMs, samples,
  }, null, 2) + "\n");
} finally {
  server.close();
  await browser.close();
}
