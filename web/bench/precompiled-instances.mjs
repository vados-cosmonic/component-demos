// Time the public async instantiation API with the same already-compiled guest and adapter cores.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import puppeteer from "puppeteer-core";
import { transpile } from "@bytecodealliance/jco";

const [compiler, dist, matrixFile, destination, traceFlag] = process.argv.slice(2);
assert(
  destination,
  "Usage: precompiled-instances.mjs <candidate compiler> <runtime dist> <matrix.gz> <output.gz>",
);
assert(!traceFlag || traceFlag === "--trace");
const traced = Boolean(traceFlag);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const raw = await readFile(matrixFile);
const matrix = JSON.parse(gunzipSync(raw));
for (const [f, hash] of Object.entries(matrix.compilers.bundled)) {
  assert.equal(
    sha(await readFile(join(compiler, f.startsWith("dist/") ? f : "vendor/" + f))),
    hash,
    f,
  );
}
const { transpileBytes } = await import(pathToFileURL(resolve(compiler, "dist/transpile.js")));
const web = join(import.meta.dirname, ".."),
  assets = new Map(),
  manifest = {},
  imports = {};
function add(path, bytes) {
  const data = Buffer.from(bytes);
  assets.set(path, data);
  manifest[path] = { bytes: data.length, sha256: sha(data) };
}
for (const [path, ref] of Object.entries(matrix.manifest)) {
  if (path.startsWith("/runtime/")) {
    add(path, await readFile(join(dist, path.slice(9))));
    const key = path.slice(9, -3);
    if (!key.startsWith("chunks/")) imports[matrix.checkedPackage + "/" + key] = path;
  } else if (
    ["/examples/table-update/main.js", "/host/common.js", "/host/web-host.js"].includes(path)
  ) {
    add(path, await readFile(join(web, path)));
  } else continue;
  assert.equal(manifest[path].sha256, ref.sha256, path);
}
const langList = ["c", "cpp", "rust"];
const builds = ["release", "bundled", "external"];
const strategies = ["default", "async", "small", "sync"];
const hostSpec = "../../../host/web-host.js";
const map = Object.fromEntries(
  (await readFile(join(web, "host/imports.txt"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const [id, name] = line.split(/\s+/);
      return [id, hostSpec + "#" + name];
    }),
);
const files = {},
  guests = {};
for (const lang of langList) {
  const guest = await readFile(join(web, lang, "table-update/native/table_update.wasm"));
  guests[lang] = sha(guest);
  for (const build of builds) {
    const base = "/" + lang + "/" + build + "/";
    const opts = {
      name: "table_update",
      map,
      minify: true,
      instantiation: "async",
      nodejsCompat: false,
      base64Cutoff: 5000,
    };
    const out =
      build === "release"
        ? await transpile(guest, opts)
        : await transpileBytes(guest, {
            ...opts,
            emitTypescriptDeclarations: false,
            namespacedExports: true,
            ...(build === "external" ? { cmRuntimeEsModule: matrix.checkedPackage } : {}),
          });
    assert.deepEqual(out.imports, [hostSpec]);
    files[base] = {};
    for (const [name, bytes] of Object.entries(out.files)) {
      if (!/\.(wasm|js)$/.test(name)) continue;
      add(base + name, bytes);
      if (name.endsWith(".wasm")) files[base][name] = manifest[base + name];
    }
    assert.deepEqual(files[base], files["/" + lang + "/release/"]);
    const core = files[base]["table_update.core.wasm"];
    assert.equal(
      core.sha256,
      matrix.manifest["/" + lang + "/table-update/" + build + "/table_update.core.wasm"].sha256,
    );
    assert(core.bytes > 5000 && Object.values(files[base]).some((f) => f.bytes < 5000));
  }
}

const server = createServer((req, res) => {
  if (req.url === "/")
    return res
      .writeHead(200, {
        "Content-Type": "text/html",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      })
      .end(
        '<!doctype html><script type="importmap">' +
          JSON.stringify({ imports }) +
          "</script><body>",
      );
  if (!assets.has(req.url)) return res.writeHead(404).end();
  res
    .writeHead(200, {
      "Content-Type": req.url.endsWith(".wasm") ? "application/wasm" : "text/javascript",
      "Cache-Control": "no-store",
    })
    .end(assets.get(req.url));
});

async function measure({ base, strategy, files, hostSpec }) {
  if (!crossOriginIsolated) throw Error("high-resolution clock unavailable");
  const host = await import("/host/web-host.js");
  const { getMeasurements } = await import("/examples/table-update/main.js");
  const { instantiate } = await import(base + "table_update.js");
  const mods = new Map(),
    names = new Map();
  await Promise.all(
    Object.keys(files).map(async (name) => {
      const mod = await WebAssembly.compileStreaming(fetch(base + name));
      mods.set(name, mod);
      names.set(mod, name);
    }),
  );
  const events = [];
  const lookup =
    strategy === "traced"
      ? (name) => {
          events.push({ action: "lookup", name, time: performance.now() });
          return mods.get(name);
        }
      : (name) => mods.get(name);
  const hostImports = { [hostSpec]: host };
  const construct = (module, imports) => {
    if (strategy === "sync" || (strategy === "small" && files[names.get(module)].bytes < 5000))
      return new WebAssembly.Instance(module, imports);
    return WebAssembly.instantiate(module, imports);
  };
  // This separate trial timestamps the real async constructor. Keep its extra
  // promise reaction and clock reads out of the four uninstrumented treatments.
  const observed = (module, imports) => {
    const name = names.get(module);
    events.push({ action: "start", name, time: performance.now() });
    return WebAssembly.instantiate(module, imports).then((instance) => {
      events.push({ action: "end", name, time: performance.now() });
      return instance;
    });
  };
  const callback =
    strategy === "traced" ? observed : strategy === "default" ? undefined : construct;
  const create = () => instantiate(lookup, hostImports, callback);
  const start = performance.now(),
    first = await create(),
    firstMs = performance.now() - start;
  first.run(8);
  const report = Object.values(getMeasurements());
  if (report.length !== 1 || !Object.values(report[0]).every((x) => Number.isFinite(x) && x >= 0))
    throw Error("invalid guest result");
  first._util?.stop();
  const measurements = Object.keys(report[0]).sort();
  if (strategy === "traced")
    return {
      firstMs,
      measurements,
      events: events.map((e) => ({ ...e, time: e.time - start })),
    };
  const batches = [];
  for (let j = 0; j < 6; j++) {
    const instances = [];
    const t = performance.now();
    for (let i = 0; i < 8; i++) instances.push(await create());
    batches.push((performance.now() - t) / instances.length);
    for (const instance of instances) instance._util?.stop();
  }
  // Record core order and callback costs separately, outside every primary timing.
  const calls = [];
  const audit = await instantiate(lookup, hostImports, async (mod, imports) => {
    const t = performance.now(),
      result = await construct(mod, imports);
    calls.push({ name: names.get(mod), ms: performance.now() - t });
    return result;
  });
  audit._util?.stop();
  return { firstMs, batches, calls, measurements };
}
const modes = traced
  ? builds.map((build) => ({ build, strategy: "traced" }))
  : builds.flatMap((build) => strategies.map((strategy) => ({ build, strategy })));
const rounds = 12,
  samples = [];
let chromium;
try {
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  for (let round = 0; round < rounds; round++) {
    const browser = await puppeteer.launch({
      executablePath: process.env.CHROME_BIN,
      pipe: true,
      args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [],
    });
    try {
      chromium = await browser.version();
      assert.equal(chromium, matrix.chromium);
      for (let j = 0; j < langList.length; j++) {
        const lang = langList[(round + j) % langList.length];
        for (let pos = 0; pos < modes.length; pos++) {
          const i = pos % 2 ? (pos + 1) / 2 : modes.length - pos / 2;
          // Three observed builds need the reverse orders as well as rotations.
          const index = traced ? Math.floor(round / 2) + (round % 2 ? 2 - pos : pos) : i + round;
          const { build, strategy } = modes[index % modes.length];
          const base = "/" + lang + "/" + build + "/";
          const page = await browser.newPage();
          try {
            await page.goto("http://127.0.0.1:" + server.address().port);
            const row = await page.evaluate(measure, {
              base,
              files: files[base],
              strategy,
              hostSpec,
            });
            assert(row.firstMs > 0);
            if (traced) {
              for (const action of ["lookup", "start", "end"])
                assert.deepEqual(
                  row.events
                    .filter((e) => e.action === action)
                    .map((e) => e.name)
                    .sort(),
                  Object.keys(files[base]).sort(),
                );
            } else {
              assert(row.batches.every((t) => t > 0));
              assert.deepEqual(
                row.calls.map((c) => c.name).sort(),
                Object.keys(files[base]).sort(),
              );
            }
            assert.deepEqual(
              row.measurements,
              ["create", "update (selected)", "clear (unselected)"]
                .flatMap((k) => [k + ": total ms", k + ": µs/row"])
                .sort(),
            );
            samples.push({ round, pos, lang, build, strategy, ...row });
          } finally {
            await page.close();
          }
        }
      }
    } finally {
      await browser.close();
    }
    console.log("Completed instantiation round", round + 1, "of", rounds);
  }
} finally {
  await new Promise((ok) => server.close(ok));
}
await writeFile(
  destination,
  gzipSync(
    JSON.stringify({
      chromium,
      matrix: sha(raw),
      revision: matrix.candidate,
      runner: sha(await readFile(import.meta.filename)),
      guests,
      manifest,
      files,
      rounds,
      traced,
      batchSize: 8,
      samples,
    }),
  ),
);
