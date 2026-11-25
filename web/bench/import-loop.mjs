// Run the same guest instructions with three generations of browser bindings.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, transpile } from "@bytecodealliance/jco";
import puppeteer from "puppeteer-core";
import { transpileBytes } from "./main/current/dist/transpile.js";

const bench = import.meta.dirname;
const rounds = Number(process.env.ROUNDS ?? 7);
assert(Number.isSafeInteger(rounds) && rounds > 0);
assert(process.argv.length === 3, "Usage: node web/bench/import-loop.mjs <jco-candidate-checkout>");
const checkout = resolve(process.argv[2]);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const inventory = JSON.parse(await readFile(join(bench, "results/candidate-sizes.json")));
const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
assert.equal(git("rev-parse", "HEAD"), inventory.candidate.commit);
assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
assert.equal((await readFile(join(bench, "main/current/commit"), "utf8")).trim(), inventory.main);
const installed = JSON.parse(await readFile(join(bench, "../node_modules/@bytecodealliance/jco/package.json")));
assert.equal(installed.version, inventory.baseline);
const generator = join(checkout, "target/debug/examples/transpile");
assert.equal(hash(await readFile(generator)), inventory.candidate.generatorSha256);

const fixture = await readFile(join(bench, "import-loop.wat"), "utf8");
const input = await parse(fixture);
const options = { name: "loop", instantiation: "async", nodejsCompat: false, base64Cutoff: 0 };
const variants = {};
const assets = {};
function record(name, files) {
  const packed = {};
  assets[name] = {};
  for (const [file, bytes] of Object.entries(files)) {
    if (!/\.(js|wasm)$/.test(file)) continue;
    packed[file] = Buffer.from(bytes).toString("base64");
    assets[name][file] = hash(bytes);
  }
  variants[name] = packed;
}
record("baseline", (await transpile(input, { ...options })).files);
record("main", (await transpileBytes(input, { ...options })).files);
const staging = await mkdtemp(join(tmpdir(), "jco-import-loop-"));
try {
  const component = join(staging, "input.wasm");
  await writeFile(component, input);
  execFileSync(generator, [component, staging, "--name=loop", "--instantiation", "--base64-cutoff=0", "--no-nodejs-compat"]);
  const files = {};
  for (const file of await readdir(staging)) {
    if (file !== "input.wasm" && /\.(js|wasm)$/.test(file)) files[file] = await readFile(join(staging, file));
  }
  record("candidate", files);
} finally {
  await rm(staging, { recursive: true, force: true });
}
const cores = files => Object.fromEntries(Object.entries(files).filter(([name]) => name.endsWith(".wasm")));
assert.deepEqual(cores(assets.candidate), cores(assets.baseline));
assert.deepEqual(cores(assets.main), cores(assets.baseline));

const iterations = 131072;
const repeats = 5;
const warmups = 2;
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_BIN, channel: process.env.CHROME_BIN ? undefined : "chrome", pipe: true,
  args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [],
});
try {
  const samples = [];
  for (let round = 0; round < rounds; round++) {
    const page = await browser.newPage();
    try {
      samples.push(...await page.evaluate(async ({ variants, round, iterations, repeats, warmups }) => {
        const guests = {};
        const sample = "tdxx-sample-id-with-ascii-bytes!";
        class Item { constructor(value) { this.value = value; } }
        const pool = Array.from({ length: 256 }, (_, i) => new Item(i));
        const host = {
          api: { Item }, number: { default: n => n & 255 },
          text: { default: s => s.charCodeAt(0) + s.charCodeAt(s.length - 1) },
          maybe: { default: n => n % 2 === 0 ? pool[n & 255] : undefined },
          acquire: { default: n => pool[n & 255] }, value: { default: item => item.value },
        };
        for (const [name, files] of Object.entries(variants)) {
          const { instantiate } = await import("data:text/javascript;base64," + files["loop.js"]);
          guests[name] = await instantiate(file => WebAssembly.compile(Uint8Array.fromBase64(files[file])), host);
        }
        // This fixture keeps at most one handle alive at a time. The control
        // does the same host work and uses the same memory and core binaries.
        const loadCore = name => WebAssembly.compile(Uint8Array.fromBase64(variants.baseline[name]));
        const storage = await WebAssembly.instantiate(await loadCore("loop.core.wasm"));
        const mem = storage.exports.mem;
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
        const memoryView = new DataView(mem.buffer);
        let live;
        guests.direct = (await WebAssembly.instantiate(await loadCore("loop.core2.wasm"), { "": {
          mem, number: host.number.default,
          "read-string": (ptr, len) => host.text.default(decoder.decode(new Uint8Array(mem.buffer, ptr, len))),
          acquire(n) {
            if (live !== undefined) throw Error("Live resource at acquire");
            live = host.acquire.default(n);
            return 1;
          },
          maybe(n, out) {
            if (live !== undefined) throw Error("Live resource at optional acquire");
            live = host.maybe.default(n);
            memoryView.setUint8(out, Number(live !== undefined));
            if (live !== undefined) memoryView.setUint32(out + 4, 1, true);
          },
          value(h) {
            if (h !== 1 || live === undefined) throw Error("Invalid borrow");
            return host.value.default(live);
          },
          drop(h) {
            if (h !== 1 || live === undefined) throw Error("Invalid drop");
            live = undefined;
          },
        } })).exports;
        const names = Object.keys(guests);
        const rows = [];
        for (const [op, length] of [["numbers"], ["strings", 2], ["strings", 9], ["strings", 32], ["resources"], ["options"]]) {
          const mean = op === "options" ? 63.5 : 127.5;
          const expected = iterations * (length ? 72.5 + sample.charCodeAt(length - 1) : mean);
          for (let pass = -warmups; pass < repeats; pass++) {
            for (let i = 0; i < names.length; i++) {
              const shift = round + pass + warmups;
              const name = names[(shift + (shift % 2 ? -i : i) + names.length) % names.length];
              const run = guests[name][op];
              const start = performance.now();
              const result = length ? run(iterations, length) : run(iterations);
              const elapsedMs = performance.now() - start;
              if (result !== expected || live !== undefined) throw Error("Wrong result for " + name + "/" + op);
              if (pass >= 0) rows.push({ round: round + 1, pass: pass + 1, name, op, length, elapsedMs });
            }
          }
        }
        return rows;
      }, { variants, round, iterations, repeats, warmups }));
    } finally {
      await page.close();
    }
    console.log("Completed import loop round", round + 1);
  }
  const result = {
    date: new Date().toISOString(), chrome: await browser.version(), cpu: cpus()[0].model,
    system: [platform(), release(), arch()], node: process.version, rounds, iterations, repeats, warmups,
    baseline: inventory.baseline, main: inventory.main, candidate: inventory.candidate, assets,
    fixtureSha256: hash(fixture), inputSha256: hash(input), runnerSha256: hash(await readFile(import.meta.filename)), samples,
  };
  await writeFile(join(bench, "results/import-loop.json"), JSON.stringify(result, null, 2) + "\n");
} finally {
  await browser.close();
}
