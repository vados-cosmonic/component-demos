// Compare browser host copies using the same core Wasm and pixel workload.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const bench = import.meta.dirname;
const web = join(bench, "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const inventoryBytes = await readFile(join(bench, "results/candidate-sizes.json"));
const inventory = JSON.parse(inventoryBytes);
const args = process.argv.slice(2);
const isolated = args[0] === "--isolated";
if (isolated) args.shift();
const [checkout, generator, previousRef, previousGenerator, output] = args;
assert((!isolated && args.length === 0) || args.length === 5,
  "Use no arguments for the inventory run, or [--isolated] <jco-checkout> <generator> <previous-ref> <previous-generator> <output.json> for paired C canvas timings");
const versions = isolated ? ["before", "after", "control"] : checkout ? ["direct", "baseline", "main", "before", "after"] : ["direct", "baseline", "main", "candidate"];
const langs = checkout ? ["c"] : ["c", "cpp", "rust"];
const rounds = Number(process.env.ROUNDS ?? (isolated ? 24 : 9));
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
let comparison;
if (checkout) {
  const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
  assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
  comparison = { revision: git("rev-parse", "HEAD"), previous: git("rev-parse", previousRef + "^{commit}"),
    generatorSha256: hash(await readFile(generator)), previousGeneratorSha256: hash(await readFile(previousGenerator)),
    entries: {} };
}
const paths = {};
for (const lang of langs) {
  const { input, variants } = inventory.components.find(c => c.input.path === lang + "/canvas-pixels/native/canvas_pixels.wasm");
  paths[lang] = {};
  let coreSha;
  for (const version of versions.slice(1).filter(v => variants[v])) {
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
  if (comparison) {
    const staging = await mkdtemp(join(tmpdir(), "jco-canvas-"));
    try {
      const component = join(web, input.path);
      assert.equal(hash(await readFile(component)), input.sha256);
      const mappings = (await readFile(join(web, "host/imports.txt"), "utf8")).trim().split("\n").map(line => {
        const [name, target] = line.trim().split(/\s+/);
        return "--map=" + name + "=../../../host/web-host.js#" + target;
      });
      for (const [version, binary] of [["before", previousGenerator], ["after", generator]]) {
        const dir = join(staging, version);
        execFileSync(resolve(binary), [component, dir, "--name=canvas_pixels", "--no-nodejs-compat",
          "--base64-cutoff=5000", "--namespaced-exports", ...mappings]);
        for (const f of await readdir(dir)) {
          const url = "/" + lang + "/canvas-pixels/jco-" + version + "/" + f;
          const bytes = await readFile(join(dir, f));
          if (f === "canvas_pixels.js") {
            paths[lang][version] = url;
            comparison.entries[version] = hash(bytes);
          } else {
            const baseline = variants.baseline.find(asset => asset.path.endsWith("/" + f));
            assert.equal(hash(bytes), baseline?.sha256, "Generated core differs for " + f);
          }
          assets.set(url, bytes);
        }
      }
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  if (isolated) paths[lang].control = paths[lang].before;
  assert.deepEqual(Object.keys(paths[lang]).sort(), [...versions].sort());
}

async function sample(page, lang, host, round, selected = versions) {
  return page.evaluate(async ({ builds, host, round, size, minMs, versions }) => {
    const { getMeasurements } = await import("/examples/canvas-pixels/main.js");
    const { installPixelViews, checkCanvasPixels } = await import("/bench/canvas-host.mjs");
    if (host === "view") installPixelViews();
    const { instantiateDomGuest } = await import("/bench/dom-core-shim.mjs");
    const direct = versions.includes("direct") ? await instantiateDomGuest(builds.direct) : undefined;
    const guests = { direct };
    for (const version of versions.filter(v => v !== "direct")) guests[version] = await import(builds[version] + (versions.length === 1 ? "?round=" + round + "&slot=" + version : ""));
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
        if (direct && direct.counts().liveHandles !== 0) throw Error("Direct guest leaked a resource");
        if (pass) rows.push({ pass, version, readUs, writeUs, pixelsChecked });
      }
    }
    return rows;
  }, { builds: paths[lang], host, round, size, minMs, versions: selected });
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
      // Across six isolated rounds each build occupies every position twice.
      // The control loads the before bytes at its own module URL.
      const order = isolated
        ? versions.map((_, j) => versions[((round - 1) + (round % 2 ? j : -j) + versions.length) % versions.length])
        : [undefined];
      const hosts = isolated ? ["original"] : (i + round) % 2 ? ["original", "view"] : ["view", "original"];
      for (const host of hosts) for (const version of order) {
        const page = await browser.newPage();
        try {
          await page.setCacheEnabled(false);
          await page.goto("http://127.0.0.1:" + server.address().port);
          const rows = await sample(page, lang, host, round, version ? [version] : versions);
          samples.push(...rows.map(row => ({ round, lang, host, ...row })));
        } finally { await page.close(); }
      }
    }
    console.log(`Canvas host round ${round}/${rounds}`);
  }
  await writeFile(output ?? join(bench, "results/canvas-host.json"), JSON.stringify({
    date: new Date().toISOString(), browser: await browser.version(), cpu: cpus()[0].model,
    runnerSha256: hash(await readFile(import.meta.filename)), sizesSha256: hash(inventoryBytes),
    sources, isolated, candidate: comparison ?? inventory.candidate, rounds, passes: 4, size, minMs, samples,
  }, null, 2) + "\n");
} finally {
  server.close();
  await browser.close();
}
