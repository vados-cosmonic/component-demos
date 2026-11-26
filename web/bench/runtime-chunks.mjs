// Measure a package-wide chunking policy on full bindings and on a single public entry.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createSecureServer } from "node:http2";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliCompressSync, constants, gunzipSync, gzipSync } from "node:zlib";
import puppeteer from "puppeteer-core";
import { bundleApp } from "./app-bundle.mjs";

const [checkout, matrixFile, output, study, ...extra] = process.argv.slice(2);
const appPreload = study === "--shaped-preload";
const shaped = study === "--shaped" || appPreload;
const compactHelpers = study === "--compact-helpers" || study === "--compact-component";
assert(!extra.length && (!study || shaped || compactHelpers));
assert(output, "Usage: runtime-chunks.mjs <built Jco checkout> <matrix.json.gz> <output.json.gz> [--shaped|--shaped-preload|--compact-helpers|--compact-component]");
const digest = (x) => createHash("sha256").update(x).digest("hex");
const matrixBytes = await readFile(matrixFile);
const matrix = JSON.parse(gunzipSync(matrixBytes));
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: checkout,
  encoding: "utf8",
}).trim();
// Documentation-only commits can use the same matrix. Each generated entry, guest
// core and shipped runtime module below must still match its recorded digest.
if (!shaped) assert.equal(revision, matrix.candidate);
const web = join(import.meta.dirname, "..");
const pkg = resolve(checkout, "packages/jco-cm-runtime");
const manifest = JSON.parse(await readFile(join(pkg, "package.json")));
const require = createRequire(join(pkg, "package.json"));
const { rolldown, VERSION } = await import(pathToFileURL(require.resolve("rolldown")));
const input = Object.fromEntries(
  Object.entries(manifest.exports)
    .filter(([k]) => !k.startsWith("./debug"))
    .map(([k, v]) => [
      k === "." ? "index" : k.slice(2),
      join(pkg, "dist/debug", v.default.slice("./dist/".length)),
    ]),
);
const assets = new Map(),
  files = {},
  imports = {},
  graph = {},
  api = {},
  footprints = {};
const builds = appPreload
  ? ["release", "bundled", "application", "application-preload"]
  : shaped
  ? ["release", "bundled", "external", "application"]
  : ["release", "bundled", "external", "grouped", "application"];
const protocols = shaped ? ["h2"] : ["http/1.1", "h2"];
const profiles = appPreload ? ["limited"] : shaped ? ["loopback", "limited"] : [null];
const emulation = { latency: 40, download: 1250000, upload: 1250000 };
const encoded = new Map();
function add(path, bytes, reference) {
  const data = Buffer.from(bytes);
  const sha256 = digest(data);
  if (reference) assert.equal(sha256, matrix.manifest[reference].sha256, reference);
  assets.set(path, data);
  files[path] = { sha256, bytes: data.length, gzip: gzipSync(data, { level: 9 }).length };
}
function closure(initial) {
  const reached = new Set(initial);
  for (const path of reached) for (const child of graph[path]) reached.add(child);
  return [...reached].sort();
}
for (const layout of shaped ? ["external"] : ["external", "grouped"]) {
  const prefix = layout === "external" ? "/runtime/" : "/grouped/";
  const bundle = await rolldown({
    input,
    platform: "neutral",
    external: [/^node:/],
    preserveEntrySignatures: "strict",
    transform: { dropLabels: ["DEBUG"] },
  });
  try {
    const { output } = await bundle.generate({
      format: "esm",
      minify: true,
      sourcemap: true,
      entryFileNames: "[name].js",
      chunkFileNames: "chunks/[name]-[hash].js",
      ...(layout === "grouped"
        ? { codeSplitting: { groups: [compactHelpers
          ? { name: "shared", test: /\/intrinsics\/(?:decode-utf8|sync-waiter|js-helper)\.js$/ }
          : { name: "common", minShareCount: 4 }] } }
        : {}),
    });
    const chunks = output.filter((x) => x.type === "chunk");
    const local = new Set(chunks.map((c) => c.fileName));
    for (const c of chunks) {
      const path = prefix + c.fileName;
      add(path, c.code, layout === "external" ? path : null);
      graph[path] = c.imports.filter((i) => local.has(i)).map((i) => prefix + i);
    }
    imports[layout] = {};
    footprints[layout] = {};
    for (const entry of Object.keys(input)) {
      const path = prefix + entry + ".js",
        names = chunks.find((c) => c.fileName === entry + ".js").exports.toSorted();
      if (layout === "external") api[entry] = names;
      else assert.deepEqual(names, api[entry], entry);
      imports[layout][
        entry === "index" ? matrix.checkedPackage : matrix.checkedPackage + "/" + entry
      ] = path;
      footprints[layout][entry] = closure([path]);
    }
  } finally {
    await bundle.close();
  }
}
const inputs = { "dom-query": [8, 2], "table-update": [8] };
for (const file of [
  "host/web-host.js",
  "host/common.js",
  ...Object.keys(inputs).map((d) => "examples/" + d + "/main.js"),
]) {
  add("/" + file, await readFile(join(web, file)), "/" + file);
}
const mapping = Object.fromEntries(
  (await readFile(join(web, "host/imports.txt"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const [id, symbol] = line.split(/\s+/);
      return [id, "../../../host/web-host.js#" + symbol];
    }),
);
const { transpileBytes } = await import(
  pathToFileURL(resolve(checkout, "packages/jco-transpile/dist/transpile.js"))
);
const cases = [],
  expected = {};
for (const demo of Object.keys(inputs))
  for (const lang of ["c", "cpp", "rust"]) {
    const key = lang + "/" + demo,
      name = demo.replaceAll("-", "_");
    const guest = await readFile(join(web, key, "native", name + ".wasm"));
    cases.push(key);
    expected[key] = {};
    for (const version of ["release", "bundled", "external"]) {
      const ref = matrix.samples.find(
        (r) => r.round === 0 && r.demo === demo && r.lang === lang && r.version === version,
      );
      const requests = ref.requests.map((x) => x.path);
      const generated =
        version === "release"
          ? null
          : (
              await transpileBytes(guest, {
                name,
                map: mapping,
                minify: true,
                base64Cutoff: 5000,
                nodejsCompat: false,
                namespacedExports: true,
                emitTypescriptDeclarations: false,
                ...(version === "external" ? { cmRuntimeEsModule: matrix.checkedPackage } : {}),
              })
            ).files;
      for (const path of requests.filter((p) => !p.startsWith("/runtime/"))) {
        add(
          path,
          generated
            ? generated[basename(path)]
            : await readFile(join(web, key, "jco-baseline-minified", basename(path))),
          path,
        );
      }
      expected[key][version] = { entry: ref.entry, requests: requests.sort() };
      if (version === "external") {
        // Public paths are the adapter's static imports. Compare both complete transitive closures.
        const publicFiles = requests.filter((p) => Object.values(imports.external).includes(p));
        assert.deepEqual(
          closure(publicFiles),
          requests.filter((p) => p.startsWith("/runtime/")).sort(),
        );
        if (shaped) continue;
        const grouped = closure(publicFiles.map((p) => p.replace("/runtime/", "/grouped/")));
        expected[key].grouped = {
          entry: ref.entry,
          requests: [...requests.filter((p) => !p.startsWith("/runtime/")), ...grouped].sort(),
        };
      }
    }
  }
// Package these same generated external entries in one application build. Both
// layouts use the identical guest Wasm at the relative URL used by the adapter.
const appCases = cases.map((key) => ({
  base: "/" + key,
  name: basename(key).replaceAll("-", "_"),
}));
const app = await bundleApp(resolve(checkout), appCases, "external", assets);
assert.equal(app.version, VERSION);
Object.assign(graph, app.graph);
for (const [path, bytes] of app.files)
  add(path, bytes, path.endsWith(".wasm") ? path.replace("/external-app/", "/external/") : null);
for (const { base, name } of appCases) {
  const entry = base + "/external-app/" + name + ".js";
  const appEntry = {
    entry,
    requests: [...closure([entry]), entry.replace(/\.js$/, ".core.wasm")].sort(),
  };
  expected[base.slice(1)].application = appEntry;
  if (appPreload) {
    assert.equal(graph[entry].length, 1, "expected one shared JS chunk");
    expected[base.slice(1)]["application-preload"] = { ...appEntry, hint: graph[entry][0] };
  }
}
const probe = study === "--compact-component" ? "component" : "conversion";
expected[probe] = {};
for (const layout of shaped ? ["external"] : ["external", "grouped"])
  expected[probe][layout] = {
    entry: imports[layout][matrix.checkedPackage + "/intrinsics/" + probe],
    requests: footprints[layout]["intrinsics/" + probe],
  };

async function measure({ demo, entry, args, probe, hint }) {
  let getMeasurements;
  if (!probe) {
    ({ getMeasurements } = await import("/examples/" + demo + "/main.js"));
    await import("/host/web-host.js");
  }
  performance.clearResourceTimings();
  const t = performance.now();
  if (hint) {
    const link = document.createElement("link");
    link.rel = "modulepreload";
    link.href = hint;
    document.head.append(link);
  }
  const mod = await import(entry);
  const ready = performance.now();
  if (probe) {
    if (probe === "component") {
      const flags = mod.initializeInstanceFlags();
      if (!(flags instanceof Map) || flags.size !== 0) throw Error("invalid component state");
    } else if (mod.toUint32({ strict: false }, -1) !== 4294967295) throw Error("invalid conversion");
  } else mod.run(...args);
  const end = performance.now();
  if (!probe) {
    const result = Object.values(getMeasurements());
    if (
      result.length !== 1 ||
      Object.keys(result[0]).length !== (demo === "dom-query" ? 3 : 6) ||
      !Object.values(result[0]).every((n) => Number.isFinite(n) && n >= 0)
    )
      throw Error("invalid demo result");
  }
  return {
    importMs: ready - t,
    firstMs: end - t,
    requests: performance.getEntriesByType("resource").map((r) => ({
      path: new URL(r.name).pathname,
      protocol: r.nextHopProtocol,
      initiator: r.initiatorType,
      bytes: r.encodedBodySize,
      decoded: r.decodedBodySize,
      transferred: r.transferSize,
      start: r.startTime - t,
      end: r.responseEnd - t,
    })),
  };
}
const dir = await mkdtemp(join(tmpdir(), "jco-chunk-tls-"));
let cert, key;
try {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      join(dir, "key"),
      "-out",
      join(dir, "cert"),
    ],
    { stdio: "ignore" },
  );
  cert = await readFile(join(dir, "cert"));
  key = await readFile(join(dir, "key"));
} finally {
  await rm(dir, { recursive: true, force: true });
}
// Trust only this run's ephemeral loopback key, including on Chrome versions with a separate trust store.
const pin = createHash("sha256")
  .update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" }))
  .digest("base64");
if (shaped) {
  for (const [path, bytes] of assets) {
    const body = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
    encoded.set(path, body);
    files[path].brotli = body.length;
  }
}
const rounds = shaped ? 16 : 20,
  samples = [],
  servers = [];
let chromium;
function handler(req, res) {
  const path = new URL(req.url, "https://localhost").pathname;
  res.setHeader("cache-control", "no-store");
  res.setHeader("cross-origin-opener-policy", "same-origin");
  res.setHeader("cross-origin-embedder-policy", "require-corp");
  if (path.startsWith("/page/")) {
    const layout = path === "/page/grouped" ? "grouped" : "external";
    res.setHeader("content-type", "text/html");
    return res.end(
      '<!doctype html><script type="importmap">' +
        JSON.stringify({ imports: imports[layout] }) +
        "</script><body></body>",
    );
  }
  if (!assets.has(path)) {
    res.writeHead(404);
    return res.end();
  }
  res.setHeader("content-type", path.endsWith(".wasm") ? "application/wasm" : "text/javascript");
  if (shaped) {
    if (!/\bbr\b/.test(req.headers["accept-encoding"] ?? "")) return res.writeHead(406).end();
    res.setHeader("content-encoding", "br");
    res.end(encoded.get(path));
  } else res.end(assets.get(path));
}
try {
  for (const protocol of protocols) {
    const server =
      protocol === "h2"
        ? createSecureServer({ cert, key }, handler)
        : createServer({ cert, key }, handler);
    servers.push(server);
    await new Promise((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
  }
  for (let round = 0; round < rounds; round++) {
    const browser = await puppeteer.launch({
      executablePath: process.env.CHROME_BIN,
      args: [
        "--ignore-certificate-errors-spki-list=" + pin,
        ...(process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
      ],
    });
    try {
      chromium = await browser.version();
      const workloads = shaped ? cases : [...cases, probe];
      for (let j = 0; j < workloads.length; j++) {
        const workload = workloads[(j + round) % workloads.length],
          isProbe = workload === probe;
        const modes = isProbe ? ["external", "grouped"] : builds;
        const treatments = protocols.flatMap((protocol, i) =>
          profiles.flatMap((profile) => modes.map((mode) => ({ protocol, mode, profile, server: servers[i] }))),
        );
        const order = appPreload ? [0, 1, 3, 2] : shaped ? [0, 1, 7, 2, 6, 3, 5, 4] : isProbe ? [0, 1, 3, 2] : [0, 1, 9, 2, 8, 3, 7, 4, 6, 5];
        for (const [position, index] of order.entries()) {
          const { mode, protocol, server, profile } = treatments[(index + round) % order.length];
          const page = await browser.newPage();
          try {
            const doc = await page.goto(
              "https://127.0.0.1:" + server.address().port + "/page/" + mode,
            );
            assert.equal(doc.status(), 200);
            const { entry, requests, hint } = expected[workload][mode],
              demo = workload.split("/")[1];
            if (shaped) {
              // Finish common page setup before throttling the timed import. Both
              // profiles use the same CDP command and an already open TLS connection.
              await page.evaluate(async (demo) => {
                await import("/examples/" + demo + "/main.js");
                await import("/host/web-host.js");
              }, demo);
              await page.emulateNetworkConditions(profile === "limited"
                ? emulation
                : { latency: 0, download: -1, upload: -1 });
            }
            const data = await page.evaluate(measure, {
              demo,
              entry,
              args: inputs[demo],
              probe: isProbe ? probe : null,
              hint,
            });
            assert(data.importMs > 0 && data.firstMs >= data.importMs);
            assert.deepEqual(data.requests.map((r) => r.path).sort(), requests);
            if (hint) {
              // Chromium can label a modulepreload as "script". Its request
              // must begin before the entry response can reveal the import.
              const shared = data.requests.find((r) => r.path === hint);
              assert(shared.start < data.requests.find((r) => r.path === entry).end);
            }
            for (const r of data.requests) {
              assert.equal(r.protocol, protocol);
              assert.equal(r.bytes, files[r.path][shaped ? "brotli" : "bytes"]);
              assert.equal(r.decoded, files[r.path].bytes);
              assert(
                r.transferred > 0 &&
                  r.start >= -0.02 &&
                  r.end >= r.start &&
                  r.end <= data.firstMs + 0.02,
              );
            }
            samples.push({ round, position, workload, mode, protocol, ...(shaped ? { profile } : {}), ...data });
          } finally {
            await page.close();
          }
        }
      }
    } finally {
      await browser.close();
    }
    console.log("Completed package layout round", round + 1, "of", rounds);
  }
} finally {
  for (const s of servers) await new Promise((ok) => s.close(ok));
}
await writeFile(
  output,
  gzipSync(
    JSON.stringify({
      revision,
      rounds,
      chromium,
      protocols,
      ...(compactHelpers ? { study } : {}),
      ...(shaped ? { study, profiles, emulation, contentEncoding: "br", brotliQuality: 11 } : {}),
      builds,
      cases,
      inputs,
      probe,
      expected,
      files,
      api,
      footprints,
      samples,
      rolldown: VERSION,
      matrixSha256: digest(matrixBytes),
      runnerSha256: digest(await readFile(import.meta.filename)),
      appBundlerSha256: digest(await readFile(join(import.meta.dirname, "app-bundle.mjs"))),
    }),
  ),
);
