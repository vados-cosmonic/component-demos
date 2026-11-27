// Measure the first full guest call and its warmed operation on the same fresh document.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import puppeteer from "puppeteer-core";

const [checkout, upstreamBuild, output, flag, previousBuild, previousRuntime, ...extra] = process.argv.slice(2);
assert(checkout && upstreamBuild && output && !extra.length && [undefined, "--minify", "--minify-checked", "--compare-compilers"].includes(flag),
  "Usage: review-matrix.mjs <built PR checkout> <upstream dist+vendor directory with commit file> <output.json.gz> [--minify [previous-transpiler-directory] | --minify-checked | --compare-compilers previous-transpiler-directory [previous-runtime-dist]]");
const minify = flag !== undefined;
const useCheckedPackage = Boolean(previousBuild) || flag === "--minify-checked";
const compareCompilers = flag === "--compare-compilers";
assert(!compareCompilers || previousBuild);
assert(!previousRuntime || compareCompilers);
assert(!previousBuild || compareCompilers || flag === "--minify", "The checked-package comparison uses minified output");
const versions = ["release", "main", "bundled", "external"];
if (compareCompilers) versions.push("previous-bundled", "previous-external");
else if (previousBuild) versions.push("previous");
const checkedPackage = "@bytecodealliance/jco-cm-runtime";
const period = versions.length % 2 ? 2 * versions.length : versions.length;
const rounds = Number(process.env.ROUNDS ?? (compareCompilers ? 12 : previousBuild ? 10 : 8));
assert(Number.isInteger(rounds) && rounds > 0 && rounds % period === 0);
const web = join(import.meta.dirname, "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
const candidate = git("rev-parse", "HEAD");
const upstream = (await readFile(join(upstreamBuild, "commit"), "utf8")).trim();
assert.match(upstream, /^[a-f0-9]{40}$/);
// Upstream main can advance after the PR branches. Record the common revision
// so results distinguish the tested compiler from the PR's base.
const commonBase = git("merge-base", upstream, candidate);
const inventoryBytes = await readFile(join(web, "bench/results/candidate-sizes.json"));
const inventory = JSON.parse(inventoryBytes);
const minifiedSizes = minify ? await readFile(join(web, "bench/results/minified-sizes.json")) : undefined;
const minifiedInventory = minify ? JSON.parse(minifiedSizes) : undefined;
if (minify) assert.equal(minifiedInventory.sizesSha256, hash(inventoryBytes));
const releaseCompiler = minify ? (await import("@bytecodealliance/jco")).transpile : undefined;
const workloads = JSON.parse(await readFile(join(web, "bench/results/candidate-browser.json"))).workloads;
const maps = (await readFile(join(web, "host/imports.txt"), "utf8")).trim().split("\n").map(line => {
  const [name, symbol] = line.split(/\s+/);
  return [name, "../../../host/web-host.js#" + symbol];
});
const tools = {};
const compilers = {};
const generators = [["bundled", join(checkout, "packages/jco-transpile")], ["main", upstreamBuild]];
if (previousBuild) generators.push(["previous", previousBuild]);
for (const [version, dir] of generators) {
  const entry = resolve(dir, "dist/transpile.js");
  tools[version] = (await import(pathToFileURL(entry))).transpileBytes;
  compilers[version] = { "dist/transpile.js": hash(await readFile(entry)) };
  for (const name of await readdir(join(dir, "vendor"))) {
    if (/^js-component-bindgen-component.*(?:\.wasm|-instantiation\.js)$/.test(name)) {
      compilers[version][name] = hash(await readFile(join(dir, "vendor", name)));
    }
  }
}
if (previousBuild && !compareCompilers) {
  // The adapter minifier is the only changed compiler stage. The runtime files
  // served to both configurations come from the same directory below.
  for (const [file, sha] of Object.entries(compilers.previous)) {
    if (file !== "dist/transpile.js") assert.equal(sha, compilers.bundled[file], file);
  }
}
const assets = new Map();
const manifest = {};
const builds = [];
function register(path, bytes) {
  assert(!assets.has(path), path);
  assets.set(path, bytes);
  manifest[path] = { bytes: bytes.length, gzip: gzipSync(bytes).length, sha256: hash(bytes) };
}
async function readAsset(file) {
  const bytes = await readFile(join(web, file.path));
  assert.equal(hash(bytes), file.sha256);
  return bytes;
}
const runtime = join(checkout, "packages/jco-cm-runtime/dist");
// Separate URL roots let the browser resolve each package's relative chunk
// imports against the distribution built with that compiler.
const runtimeDirs = [["/runtime/", runtime]];
if (previousRuntime) runtimeDirs.push(["/previous-runtime/", previousRuntime]);
for (const [prefix, dir] of runtimeDirs) {
  for (const file of await readdir(dir, { recursive: true })) {
    if (file.endsWith(".js") && !file.startsWith("debug/")) register(prefix + file, await readFile(join(dir, file)));
  }
}
for (const path of ["host/common.js", "host/web-host.js", ...Object.keys(workloads).map(d => "examples/" + d + "/main.js")]) {
  register("/" + path, await readFile(join(web, path)));
}
for (const { input, variants } of inventory.components) {
  const [lang, demo] = input.path.split("/");
  const name = basename(input.path, ".wasm");
  if (!Object.hasOwn(workloads, demo) || name !== demo.replaceAll("-", "_")) continue;
  const component = await readAsset(input);
  let reference;
  for (const version of versions) {
    const dir = "/" + lang + "/" + demo + "/" + version;
    const options = { name, nodejsCompat: false, minify, base64Cutoff: 5000, namespacedExports: true,
      emitTypescriptDeclarations: false, map: Object.fromEntries(maps) };
    if (version === "external" || version === "previous" || version === "previous-external") {
      Object.assign(options, useCheckedPackage ? { cmRuntimeEsModule: checkedPackage } : { cmRuntimeEsModule: "/runtime", cmRuntimeSyncImports: true });
    }
    let files;
    if (version === "release" && minify) {
      const release = await releaseCompiler(component, { name, nodejsCompat: false, map: Object.fromEntries(maps), minify });
      files = {};
      for (const asset of minifiedInventory.components[input.path]["baseline-minified"]) {
        const filename = basename(asset.path);
        assert.equal(hash(release.files[filename]), asset.sha256, asset.path);
        files[filename] = release.files[filename];
      }
    } else if (version === "release") {
      files = Object.fromEntries(await Promise.all(variants.baseline.map(async file => [basename(file.path), await readAsset(file)])));
    } else {
      const generator = version.startsWith("previous") ? tools.previous : tools[version] ?? tools.bundled;
      files = (await generator(component, options)).files;
    }
    const cores = {};
    for (const [file, bytes] of Object.entries(files)) {
      assert(/\.(js|wasm)$/.test(file), file);
      register(dir + "/" + file, bytes);
      if (file.endsWith(".wasm")) cores[file] = hash(bytes);
    }
    if (version === "release") reference = cores;
    else assert.deepEqual(cores, reference, input.path);
    builds.push({ demo, lang, version, entry: dir + "/" + name + ".js", kind: "jco" });
  }
}
assert.equal(builds.length, versions.length * 3 * Object.keys(workloads).length);
for (const [directory, files] of Object.entries(inventory.alternatives)) {
  const [lang, source, backend] = directory.split("/");
  const demo = source.replace(/-wasm-bindgen$/, "");
  if (!Object.hasOwn(workloads, demo)) continue;
  for (const file of files) register("/" + file.path, await readAsset(file));
  const entry = "/" + files.find(f => /\.m?js$/.test(f.path)).path;
  builds.push({ demo, lang, entry, version: backend ?? "wasm-bindgen", kind: backend ?? "wasm-bindgen" });
}

// Executed by the page after the DevTools client disconnects. Read each guest's own report
// before clearing its DOM so a missing or malformed result fails the trial.
async function measure({ demo, kind, entry }, args) {
  const { getMeasurements } = await import("/examples/" + demo + "/main.js");
  performance.clearResourceTimings();
  const start = performance.now();
  const mod = await import(entry);
  let run = mod.run;
  if (kind === "wasm-bindgen") await mod.default();
  if (kind === "emscripten" || kind === "em-js") {
    const instance = await mod.default();
    run = kind === "em-js" ? instance._run : instance.run;
  }
  const ready = performance.now();
  function report() {
    const values = Object.values(getMeasurements());
    if (values.length !== 1 || !Object.keys(values[0]).length ||
        !Object.values(values[0]).every(x => Number.isFinite(x) && x >= 0)) throw Error("Invalid workload report for " + entry);
    return values[0];
  }
  run(...args);
  const first = performance.now(), cold = report();
  document.body.replaceChildren();
  performance.clearMarks();
  performance.clearMeasures();
  run(...args);
  const warm = report();
  const requests = performance.getEntriesByType("resource").map(r => ({
    path: new URL(r.name).pathname, bytes: r.encodedBodySize, transferred: r.transferSize,
  }));
  return { loadMs: ready - start, firstResultMs: first - start, cold, warm, requests };
}

let seed = 18671;
function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = Math.floor(seed / 4294967296 * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
const importMaps = {};
if (useCheckedPackage) {
  for (const [prefix] of runtimeDirs) {
    const imports = Object.fromEntries([...assets.keys()].filter(path => path.startsWith(prefix)).map(path =>
      [checkedPackage + "/" + path.slice(prefix.length, -3), path]));
    importMaps[prefix] = '<script type="importmap">' + JSON.stringify({ imports }) + '</script>';
  }
}
const groups = Map.groupBy(builds, b => b.kind === "jco" ? b.demo + "/" + b.lang : b.entry);
const sequences = [[0,1,3,2], [1,2,0,3], [2,3,1,0], [3,0,2,1]];
if (compareCompilers) {
  // Six rotations cover each timing position and each immediate predecessor.
  sequences.length = 0;
  for (let shift = 0; shift < versions.length; shift++)
    sequences.push([0,1,5,2,4,3].map(i => (i + shift) % versions.length));
} else if (previousBuild) {
  // An odd number of treatments needs both directions of each rotation for
  // every ordered pair to occur equally often as immediate predecessors.
  sequences.length = 0;
  for (let shift = 0; shift < 5; shift++) {
    const row = [0,1,4,2,3].map(i => (i + shift) % 5);
    sequences.push(row, row.toReversed());
  }
}
const blocks = new Map();
const samples = [];
let chromium;
class PageTimeout extends Error {}
const discardedRounds = [];
for (let round = 0; round < rounds; round++) {
  const queue = [];
  for (const key of shuffle([...groups.keys()])) {
    const group = groups.get(key);
    if (group.length === 1) { queue.push(group[0]); continue; }
    assert.equal(group.length, versions.length);
    if (round % sequences.length === 0) blocks.set(key, { labels: shuffle(group), order: shuffle(sequences) });
    const { labels, order } = blocks.get(key);
    queue.push(...order[round % sequences.length].map(i => labels[i]));
  }
  // Restart the whole balanced round after a browser hang. Keeping a partial
  // round would give some builds more observations or a different predecessor.
  for (let attempt = 0; ; attempt++) {
    try {
      samples.push(...await measureRound(round, queue));
      break;
    } catch (error) {
      if (!(error instanceof PageTimeout) || attempt === 2) throw error;
      discardedRounds.push({ round, attempt, reason: error.message });
      console.warn("Repeating round", round + 1, error.message);
    }
  }
  console.log("Completed full matrix round", round + 1, "of", rounds);
}
await writeFile(output, gzipSync(JSON.stringify({ release: inventory.baseline, upstream, commonBase, candidate, compilers, rounds, chromium,
  discardedRounds, minify, ...(compareCompilers && { compareCompilers }), checkedPackage: useCheckedPackage ? checkedPackage : undefined, minifiedInventorySha256: minify ? hash(minifiedSizes) : undefined,
  node: process.version, cpu: cpus()[0].model, inventorySha256: hash(inventoryBytes), runnerSha256: hash(await readFile(import.meta.filename)),
  workloads, manifest, samples }), { level: 9 }));

async function measureRound(round, queue) {
  const roundSamples = [];
  const gate = Promise.withResolvers(), done = Promise.withResolvers();
  done.promise.catch(() => {});
  let position = 0;
  // A busy machine can take more than 90 seconds for a whole round.
  // Reset the inactivity timer after each verified document.
  const watchdog = setTimeout(() => {
    const build = queue[position];
    done.reject(new PageTimeout(`Page stopped responding at ${position}: ${build?.entry}`));
  }, 90000);
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      if (path === "/") {
        res.setHeader("Content-Type", "text/html");
        return res.end('<script>fetch("/gate").then(() => location.replace("/trial/0"))</script>');
      }
      if (path === "/gate") { await gate.promise; return res.end(); }
      if (path === "/favicon.ico") return res.writeHead(204).end();
      const build = queue[position];
      const runtimePrefix = previousRuntime && build.version === "previous-external" ? "/previous-runtime/" : "/runtime/";
      if (path === "/trial/" + position) {
        res.setHeader("Content-Type", "text/html");
        const map = importMaps[runtimePrefix] ?? "";
        return res.end(`<!doctype html><head>${map}</head><body><script type="module">
          let data;
          try { data = await (${measure})(${JSON.stringify(build)}, ${JSON.stringify(Object.values(workloads[build.demo]))}) }
          catch (e) { data = { error: String(e.stack || e) } }
          const next = await (await fetch("/result/${position}", {method:"POST",body:JSON.stringify(data)})).text();
          if (next) location.replace(next);
        </script>`);
      }
      if (req.method === "POST" && path === "/result/" + position) {
        let body = "";
        for await (const chunk of req) body += chunk;
        const data = JSON.parse(body);
        assert(!data.error, data.error);
        assert(data.loadMs > 0 && data.firstResultMs > data.loadMs);
        assert(data.requests.some(r => r.path === build.entry));
        for (const request of data.requests) {
          assert.equal(request.bytes, manifest[request.path].bytes, request.path);
          assert(request.transferred > 0);
        }
        if (useCheckedPackage && ["previous", "external", "previous-external"].includes(build.version)) {
          assert(data.requests.some(r => r.path === runtimePrefix + "intrinsics/sync.js"));
        }
        roundSamples.push({ round, position, ...build, ...data });
        position++;
        watchdog.refresh();
        if (position === queue.length) { res.end(); done.resolve(); }
        else res.end("/trial/" + position);
        return;
      }
      const bytes = assets.get(path);
      assert(bytes, path);
      res.setHeader("Content-Type", path.endsWith(".wasm") ? "application/wasm" : "text/javascript");
      res.end(bytes);
    } catch (e) { res.writeHead(500).end(); done.reject(e); }
  });
  let browser, endpoint;
  try {
    await new Promise((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
    browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN, channel: process.env.CHROME_BIN ? undefined : "chrome",
      args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [] });
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
    } finally { server.closeAllConnections(); server.close(); }
  }
  return roundSamples;
}
