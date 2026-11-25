import http from "node:http";
import { cpus, arch, platform, release } from "node:os";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import puppeteer from "puppeteer-core";

const web = resolve(import.meta.dirname, "..");
const candidate = process.env.BENCH_CANDIDATE === "1";
const prefix = candidate ? "candidate-" : "";
const sizeData = await readFile(resolve(import.meta.dirname, `results/${prefix}sizes.json`));
const inventory = JSON.parse(sizeData);
const rounds = Number(process.env.ROUNDS ?? 7);
if (!Number.isInteger(rounds) || rounds < 1) throw new Error("ROUNDS must be a positive integer");

// Bind the timings to the exact generated files and alternative builds in the report.
const outputs = inventory.components.flatMap(c => Object.values(c.variants).flat());
for (const asset of [...outputs, ...Object.values(inventory.alternatives).flat()]) {
  const bytes = await readFile(resolve(web, asset.path));
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
    throw new Error(`Asset changed since bench:sizes ran: ${asset.path}`);
  }
}

// Arguments are passed unchanged to each implementation's exported run function.
const workloads = {
  "attribute-churn": { elements: 2000, iters: 10 },
  "canvas-draw": { rects: 50000 },
  "canvas-pixels": { size: 256, minMs: 10 },
  "dom-query": { numElements: 2000, iters: 10 },
  "dom-traversal": { depth: 6, numChildren: 5 },
  "string-marshalling": { minMs: 10 },
  "table-update": { rows: 2000 },
};

const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    if (path === "/") {
      res.setHeader("Content-Type", "text/html");
      return res.end("<!doctype html><html><head><title>Benchmark</title></head><body></body></html>");
    }
    const file = resolve(web, "." + decodeURIComponent(path));
    const mime = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm" }[extname(file)];
    if (!file.startsWith(web + sep) || !mime) throw new Error("Unknown asset");
    res.setHeader("Content-Type", mime);
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_BIN,
  channel: process.env.CHROME_BIN ? undefined : "chrome",
  headless: true,
  pipe: true,
  args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [],
});

function implementations(demo) {
  const runs = [{ label: "JS", kind: "js" }];
  for (const [directory, assets] of Object.entries(inventory.alternatives)) {
    const [lang, name, backend] = directory.split("/");
    if (name !== demo && name !== demo + "-wasm-bindgen") continue;
    runs.push({
      label: lang === "rust" ? "Rust wasm-bindgen" : "C++ " + backend,
      kind: backend ?? "wasm-bindgen",
      path: "/" + assets.find(f => /\.m?js$/.test(f.path)).path,
    });
  }
  for (const c of inventory.components) {
    const [lang, name] = c.input.path.split("/");
    const stem = demo.replaceAll("-", "_");
    if (name !== demo || !c.input.path.endsWith("/" + stem + ".wasm")) continue;
    for (const [version, files] of Object.entries(c.variants)) {
      const entry = files.find(f => f.path.endsWith("/" + stem + ".js"));
      runs.push({ label: `${lang} ${version}`, kind: "jco", path: "/" + entry.path });
    }
  }
  return runs;
}

async function sample(page, demo, impl, args) {
  return await page.evaluate(async (demo, impl, args) => {
    const { runRawJs, getMeasurements } = await import(`/examples/${demo}/main.js`);
    let run = runRawJs;
    let loadMs = null;
    if (impl.path) {
      const start = performance.now();
      const mod = await import(impl.path);
      if (impl.kind === "emscripten" || impl.kind === "em-js") {
        const instance = await mod.default();
        run = impl.kind === "em-js" ? instance._run : instance.run;
      } else {
        if (impl.kind === "wasm-bindgen") await mod.default();
        run = mod.run;
      }
      loadMs = performance.now() - start;
    }

    run(...args);
    document.body.replaceChildren();
    performance.clearMarks();
    performance.clearMeasures();
    run(...args);
    const reports = Object.values(getMeasurements());
    if (reports.length !== 1 || !Object.keys(reports[0]).length ||
        !Object.values(reports[0]).every(v => Number.isFinite(v) && v >= 0)) {
      throw new Error("Missing or invalid workload report");
    }
    return { loadMs, seconds: reports[0] };
  }, demo, impl, args);
}

try {
  await new Promise((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const result = {
    date: new Date().toISOString(), browser: await browser.version(), node: process.version,
    os: [platform(), release(), arch()].join(" "), cpu: cpus()[0].model, rounds, workloads,
    baseline: inventory.baseline, main: inventory.main,
    candidate: inventory.candidate, reference: inventory.reference, sizesSha256: createHash("sha256").update(sizeData).digest("hex"), samples: [],
  };
  for (const [demo, params] of Object.entries(workloads)) {
    console.log(demo);
    const variants = implementations(demo);
    for (let round = 0; round < rounds; round++) {
      // Rotate the starting implementation and alternate traversal direction.
      for (let i = 0; i < variants.length; i++) {
        const impl = variants[(round + (round % 2 ? -i : i) + variants.length) % variants.length];
        const page = await browser.newPage();
        try {
          await page.setCacheEnabled(false);
          await page.goto(base);
          const data = await sample(page, demo, impl, Object.values(params));
          result.samples.push({ demo, implementation: impl.label, round: round + 1, ...data });
        } catch (err) {
          throw new Error(`${demo} / ${impl.label} / round ${round + 1}: ${err.message}`, { cause: err });
        } finally {
          await page.close();
        }
      }
    }
  }
  await writeFile(resolve(import.meta.dirname, `results/${prefix}browser.json`), JSON.stringify(result, null, 2) + "\n");
} finally {
  server.close();
  await browser.close();
}
