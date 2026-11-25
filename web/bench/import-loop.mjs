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
const pixelCopies = 2048;
const textCopies = 1024;
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_BIN, channel: process.env.CHROME_BIN ? undefined : "chrome", pipe: true,
  args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [],
});
try {
  const samples = [];
  for (let round = 0; round < rounds; round++) {
    const page = await browser.newPage();
    try {
      samples.push(...await page.evaluate(async ({ variants, round, iterations, repeats, warmups, pixelCopies, textCopies }) => {
        const guests = {};
        const sample = "tdxx-sample-id-with-ascii-bytes!";
        class Item { constructor(value) { this.value = value; } }
        const pool = Array.from({ length: 256 }, (_, i) => new Item(i));
        const source = new Uint8Array(176 * 176 * 4 + 2).subarray(1, -1);
        for (let i = 0; i < source.length; i++) source[i] = i & 255;
        const encoder = new TextEncoder();
        const ascii = "x".repeat(16384);
        const texts = Array(4).fill(ascii);
        for (const [i, unit] of ["é", "漢", "😀", "aé漢😀"].entries()) {
          const width = encoder.encode(unit).length;
          texts.push(String.fromCharCode(65 + i) + unit.repeat(Math.floor(16383 / width)) + "z".repeat(16383 % width));
        }
        const digests = texts.map(text => {
          const bytes = encoder.encode(text);
          if (bytes.length !== 16384) throw Error("Unexpected UTF-8 fixture length");
          return bytes.reduce((hash, byte) => Math.imul(hash ^ byte, 16777619), 2166136261) >>> 0;
        });
        let lastPixelWrite;
        const host = {
          "get-text": { default: selector => texts[selector] },
          pixels: { default(n) { source[0] = n & 255; return source; } },
          "send-pixels": { default(bytes) {
            if (bytes.byteLength !== source.byteLength) throw Error("Wrong pixel write length");
            lastPixelWrite = bytes;
            return bytes[0];
          } },
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
        function writeBytes(bytes, out) {
          const ptr = storage.exports.realloc(0, 0, 1, bytes.length);
          new Uint8Array(mem.buffer, ptr, bytes.length).set(bytes);
          memoryView.setUint32(out + 4, bytes.length, true);
          memoryView.setUint32(out, ptr, true);
        }
        let live;
        const direct = (await WebAssembly.instantiate(await loadCore("loop.core2.wasm"), { "": {
          mem, number: host.number.default,
          "read-string": (ptr, len) => host.text.default(decoder.decode(new Uint8Array(mem.buffer, ptr, len))),
          "get-text"(selector, out) { writeBytes(encoder.encode(host["get-text"].default(selector)), out); },
          pixels(n, out) { writeBytes(host.pixels.default(n), out); },
          "send-pixels"(ptr, len) { return host["send-pixels"].default(new Uint8Array(mem.buffer.slice(ptr, ptr + len))); },
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
        guests.direct = { ...direct, checkPixels: direct["check-pixels"], pixelWrites: direct["pixel-writes"],
          textReturns: direct["text-returns"], textDigest: direct["text-digest"] };
        for (const guest of Object.values(guests)) {
          guest.asciiResult = count => guest.textReturns(count, 0);
          guest.unicodeResult = count => guest.textReturns(count, 4);
        }
        const names = Object.keys(guests);
        const rows = [];
        const cases = [
          { op: "numbers", count: iterations, mean: 127.5 },
          ...[2, 9, 32].map(length => ({ op: "strings", length, count: iterations, mean: 72.5 + sample.charCodeAt(length - 1) })),
          { op: "resources", count: iterations, mean: 127.5 },
          { op: "options", count: iterations, mean: 63.5 },
          { op: "pixels", count: pixelCopies, mean: 127.5 },
          { op: "pixelWrites", count: pixelCopies, mean: 127.5 },
          { op: "asciiResult", count: textCopies, mean: 120, selectors: [0] },
          { op: "unicodeResult", count: textCopies, mean: 66.5, selectors: [4, 5, 6, 7] },
        ];
        for (const { op, length, count, mean, selectors } of cases) {
          const expected = count * mean;
          for (let pass = -warmups; pass < repeats; pass++) {
            for (let i = 0; i < names.length; i++) {
              const shift = round + pass + warmups;
              const name = names[(shift + (shift % 2 ? -i : i) + names.length) % names.length];
              const run = guests[name][op];
              if (op === "pixelWrites") {
                // Initialize the guest region outside the timer, including when this case runs alone.
                guests[name].pixels(1);
                lastPixelWrite = undefined;
              }
              const start = performance.now();
              const result = length ? run(count, length) : run(count);
              const elapsedMs = performance.now() - start;
              if (result !== expected || live !== undefined) throw Error("Wrong result for " + name + "/" + op);
              if (op === "pixels" && guests[name].checkPixels() !== 1) throw Error("Invalid pixel bytes for " + name);
              if (op === "pixelWrites" && (!lastPixelWrite || !lastPixelWrite.every((byte, i) => byte === (i ? i & 255 : 1)))) {
                throw Error("Incorrect or aliased guest-to-host pixel snapshot for " + name);
              }
              for (const selector of selectors ?? []) {
                if ((guests[name].textDigest(selector) >>> 0) !== digests[selector]) throw Error("Wrong UTF-8 bytes for " + name + "/" + selector);
              }
              if (pass >= 0) rows.push({ round: round + 1, pass: pass + 1, name, op, length, count, elapsedMs });
            }
          }
        }
        return rows;
      }, { variants, round, iterations, repeats, warmups, pixelCopies, textCopies }));
    } finally {
      await page.close();
    }
    console.log("Completed import loop round", round + 1);
  }
  const result = {
    date: new Date().toISOString(), chrome: await browser.version(), cpu: cpus()[0].model,
    system: [platform(), release(), arch()], node: process.version, rounds, iterations, repeats, warmups, pixelCopies, textCopies,
    baseline: inventory.baseline, main: inventory.main, candidate: inventory.candidate, assets,
    fixtureSha256: hash(fixture), inputSha256: hash(input), runnerSha256: hash(await readFile(import.meta.filename)), samples,
  };
  await writeFile(join(bench, "results/import-loop.json"), JSON.stringify(result, null, 2) + "\n");
} finally {
  await browser.close();
}
