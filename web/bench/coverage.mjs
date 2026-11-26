// Collect generated JavaScript source coverage separately from timing trials.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const web = resolve(import.meta.dirname, "..");
const results = join(import.meta.dirname, "results");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const inventoryBytes = await readFile(join(results, "candidate-sizes.json"));
const inventory = JSON.parse(inventoryBytes);
const timing = JSON.parse(await readFile(join(results, "candidate-browser.json")));
assert.equal(timing.sizesSha256, hash(inventoryBytes));
const origin = "http://localhost";
const assets = new Map([["/", Buffer.from("<!doctype html><body></body>")]]);
const sources = {};
for (const path of ["host/common.js", "host/web-host.js", ...Object.keys(timing.workloads).map(d => `examples/${d}/main.js`)]) {
  const bytes = await readFile(join(web, path));
  assets.set("/" + path, bytes);
  sources[path] = hash(bytes);
}
const builds = [];
for (const component of inventory.components) {
  const [lang, demo] = component.input.path.split("/");
  const stem = demo.replaceAll("-", "_");
  if (!timing.workloads[demo] || basename(component.input.path) !== stem + ".wasm") continue;
  for (const version of ["baseline", "main", "candidate"]) {
    const files = component.variants[version];
    for (const file of files) {
      const bytes = await readFile(join(web, file.path));
      assert.equal(hash(bytes), file.sha256, file.path);
      assets.set("/" + file.path, bytes);
    }
    const scripts = files.filter(f => f.path.endsWith(".js"));
    assert.equal(scripts.length, 1, "Expected one bundled JS module for " + component.input.path);
    builds.push({ lang, demo, version, path: scripts[0].path, sha256: scripts[0].sha256 });
  }
}

// Puppeteer returns disjoint V8 ranges in UTF-16 code units. Report the size
// of those slices in UTF-8 bytes, matching the uncompressed payload inventory.
function usedBytes(entry, from = 0, to = entry.text.length) {
  let end = 0;
  let used = 0;
  for (const range of entry.ranges) {
    assert(range.start >= end && range.start <= range.end && range.end <= entry.text.length);
    const start = Math.max(range.start, from);
    const stop = Math.min(range.end, to);
    if (start < stop) used += Buffer.byteLength(entry.text.slice(start, stop));
    end = range.end;
  }
  return used;
}

// V8 gives the outer function's offsets, including any nested class methods.
// Intersect with disjoint block ranges to count each reached byte once.
function runtimeFactories(entry) {
  const factories = [];
  for (const fn of entry.rawScriptCoverage.functions) {
    const name = /^__jcoEmbeddedRuntime\$define([A-Z]\w*)$/.exec(fn.functionName)?.[1];
    if (!name) continue;
    const { startOffset, endOffset } = fn.ranges[0];
    assert(0 <= startOffset && startOffset < endOffset && endOffset <= entry.text.length);
    factories.push({ name, bytes: Buffer.byteLength(entry.text.slice(startOffset, endOffset)),
      used: usedBytes(entry, startOffset, endOffset) });
  }
  return factories;
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_BIN, channel: process.env.CHROME_BIN ? undefined : "chrome",
  pipe: true, args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [],
});
const samples = [];
try {
  for (const build of builds) {
    for (const runGuest of [false, true]) {
      const page = await browser.newPage();
      try {
        await page.setRequestInterception(true);
        page.on("request", request => {
          const url = new URL(request.url());
          const body = url.origin === origin ? assets.get(url.pathname) : undefined;
          if (!body) return request.abort();
          const contentType = url.pathname === "/" ? "text/html" : url.pathname.endsWith(".wasm") ? "application/wasm" : "text/javascript";
          return request.respond({ status: 200, contentType, body, headers: {
            "Cache-Control": "no-store", "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
          } });
        });
        await page.goto(origin);
        await page.coverage.startJSCoverage({ useBlockCoverage: true, includeRawScriptCoverage: build.version === "candidate" });
        await page.evaluate(async ({ path, demo, args, runGuest }) => {
          const guest = await import("/" + path);
          if (runGuest) {
            await guest.run(...args);
            const { getMeasurements } = await import(`/examples/${demo}/main.js`);
            const reports = Object.values(getMeasurements());
            if (reports.length !== 1 || !Object.keys(reports[0]).length ||
                !Object.values(reports[0]).every(value => Number.isFinite(value) && value >= 0)) {
              throw Error("Invalid guest output");
            }
          }
        }, { ...build, args: Object.values(timing.workloads[build.demo]), runGuest });
        const entry = (await page.coverage.stopJSCoverage()).find(source => source.url === origin + "/" + build.path);
        assert(entry && hash(entry.text) === build.sha256, "Unexpected script for " + build.path);
        samples.push({ ...build, phase: runGuest ? "firstRun" : "init",
          bytes: Buffer.byteLength(entry.text), used: usedBytes(entry),
          ...(build.version === "candidate" ? { factories: runtimeFactories(entry) } : {}) });
      } finally {
        await page.close();
      }
    }
  }
  await writeFile(join(results, "js-coverage.json"), JSON.stringify({
    date: new Date().toISOString(), browser: await browser.version(), node: process.version, sizesSha256: hash(inventoryBytes),
    runnerSha256: hash(await readFile(import.meta.filename)), sources, workloads: timing.workloads, samples,
  }, null, 2) + "\n");
  console.log(`Collected ${samples.length} coverage samples`);
} finally {
  await browser.close();
}
