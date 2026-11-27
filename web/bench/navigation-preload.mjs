// Does a deployment manifest in the HTML response bring a first visit closer to release?
// Start the clock at navigation, before Chromium can discover or act on the header.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { brotliCompressSync, gzipSync } from "node:zlib";
import puppeteer from "puppeteer-core";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");

async function runGuest(demo, entry, args) {
  const { getMeasurements } = await import("/examples/" + demo + "/main.js");
  const guest = await import(entry);
  const ready = performance.now();
  guest.run(...args);
  const first = performance.now();
  const reports = Object.values(getMeasurements());
  if (reports.length !== 1 || !Object.keys(reports[0]).length ||
      !Object.values(reports[0]).every(n => Number.isFinite(n) && n >= 0)) throw Error("Invalid guest result");
  return { ready, first, responseStart: performance.getEntriesByType("navigation")[0].responseStart,
    requests: performance.getEntriesByType("resource").map(r => ({
      path: new URL(r.name).pathname, start: r.startTime, end: r.responseEnd,
      encoded: r.encodedBodySize, decoded: r.decodedBodySize, initiator: r.initiatorType,
    })) };
}

export async function measureNavigation({ assets, imports, entries, expected, versions, matrix, matrixBytes, lang, demo, output }) {
  const wire = new Map([...assets].map(([path, bytes]) => [path, brotliCompressSync(bytes)]));
  const treatments = versions.flatMap(version => [false, true].map(hints => ({ version, hints })));
  const samples = [], delayMs = 10, rounds = 12;
  let served;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    if (path.startsWith("/trial/")) {
      const { version, hints } = treatments[Number(path.slice(7))];
      if (hints) res.setHeader("Link", expected[version].map(url => url.endsWith(".wasm")
        ? `<${url}>; rel=preload; as=fetch; type="application/wasm"; crossorigin=anonymous`
        : `<${url}>; rel=modulepreload; crossorigin=anonymous`).join(", "));
      const args = [demo, entries[version], Object.values(matrix.workloads[demo])];
      return res.writeHead(200, { "Content-Type": "text/html" }).end(
        '<!doctype html><head><script type="importmap">' + JSON.stringify({ imports }) +
        '</script></head><body><script type="module">window.result = (' + runGuest + ')(...' + JSON.stringify(args) + ')</script>');
    }
    if (!wire.has(path)) return res.writeHead(404).end();
    served.push(path);
    await delay(delayMs);
    res.writeHead(200, { "Content-Type": path.endsWith(".wasm") ? "application/wasm" : "text/javascript",
      "Content-Encoding": "br", "Content-Length": wire.get(path).length }).end(wire.get(path));
  });
  let browser;
  try {
    await new Promise((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
    browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN, pipe: true,
      args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [] });
    for (let round = 0; round < rounds; round++) {
      // Six rotations balance position and immediate predecessor across every treatment.
      for (const [position, offset] of [0, 1, 5, 2, 4, 3].entries()) {
        const index = (round + offset) % treatments.length;
        const { version, hints } = treatments[index];
        const context = await browser.createBrowserContext();
        try {
          served = [];
          const page = await context.newPage();
          await page.goto("http://127.0.0.1:" + server.address().port + "/trial/" + index);
          const sample = await page.evaluate(() => window.result);
          assert(sample.first >= sample.ready && sample.ready > sample.responseStart);
          const paths = [...new Set([...expected[version], "/host/common.js", "/host/web-host.js", "/examples/" + demo + "/main.js"])].sort();
          assert.deepEqual([...served].sort(), paths, "Every asset must reach the server once");
          const requests = sample.requests.filter(r => assets.has(r.path) && r.encoded);
          assert.deepEqual(requests.map(r => r.path).sort(), paths);
          for (const r of requests) {
            assert.equal(r.encoded, wire.get(r.path).length, r.path);
            assert.equal(r.decoded, assets.get(r.path).length, r.path);
          }
          samples.push({ round, position, version, hints, ...sample, served });
        } finally { await context.close(); }
      }
    }
    await writeFile(output, gzipSync(JSON.stringify({ candidate: matrix.candidate, matrix: digest(matrixBytes),
      harness: digest(await readFile(import.meta.filename)), assetsRunner: digest(await readFile(new URL("matrix-startup-phases.mjs", import.meta.url))),
      browser: await browser.version(), rounds, delayMs, lang, demo, entries, expected, samples })));
  } finally { await browser?.close(); server.closeAllConnections(); server.close(); }
}
