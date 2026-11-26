// Isolate the list<u8> copy from canvas readback with a fixed, preallocated host payload.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { parse } from "@bytecodealliance/jco";
import puppeteer from "puppeteer-core";
import { hash, prepareBindings } from "./paired-bindings.mjs";

const [checkout, generator, output, previousRef, previousGenerator] = process.argv.slice(2);
assert(checkout && generator && output, "Usage: byte-transfer.mjs <checkout> <generator> <output.json> [<previous-ref> <previous-generator>]");
const fixture = await readFile(new URL("byte-transfer.wat", import.meta.url), "utf8");
const input = await parse(fixture);
const { cores, serve, labels, metadata } = await prepareBindings({ checkout, generator, previousRef, previousGenerator, input, name: "copy" });
const encoded = Object.fromEntries(Object.entries(cores).map(([name, bytes]) => [name, bytes.toString("base64")]));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN, pipe: true,
  args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [] });
const samples = [];
try {
  for (let round = 0; round < 12; round++) {
    const page = await browser.newPage();
    try {
      await serve(page);
      samples.push(...await page.evaluate(async ({ encoded, labels, round }) => {
        const modules = {};
        for (const [name, bytes] of Object.entries(encoded)) modules[name] = await WebAssembly.compile(Uint8Array.fromBase64(bytes));
        let buffers;
        function read(length, pattern) {
          const view = buffers[pattern];
          if (view.length !== length) throw Error("Host and guest disagree on byte count");
          return view;
        }
        const guests = {};
        for (const label of labels) {
          const { instantiate } = await import("/" + label + "/copy.js");
          guests[label] = await instantiate(f => modules[f], { read: { default: read } });
        }
        // The hand-written lower uses the same guest allocator and returns
        // (pointer, length) in the same little-endian canonical ABI layout.
        const { memory, realloc } = (await WebAssembly.instantiate(modules["copy.core.wasm"])).exports;
        const view = new DataView(memory.buffer);
        guests.direct = (await WebAssembly.instantiate(modules["copy.core2.wasm"], { "": {
          mem: memory, read(length, pattern, out) {
            const bytes = read(length, pattern), ptr = realloc(0, 0, 1, length);
            new Uint8Array(memory.buffer, ptr, length).set(bytes);
            view.setUint32(out + 4, length, true);
            view.setUint32(out, ptr, true);
          },
        } })).exports;
        const modes = Object.keys(guests), rows = [];
        const lengths = [16, 256, 4096, 123904];
        for (let k = 0; k < lengths.length; k++) {
          const length = lengths[(round + k) % lengths.length];
          const count = length < 1024 ? 32768 : length === 4096 ? 8192 : 512;
          buffers = [0, 1].map(pattern => {
            const bytes = new Uint8Array(length + 14).subarray(7, -7);
            for (let i = 0; i < length; i++) bytes[i] = (i + pattern * 31) & 255;
            return bytes;
          });
          const sum = buffers.reduce((total, bytes) => total + bytes[0] + bytes[length - 1], 0) * count / 2;
          const digest = buffers[1].reduce((a, b) => Math.imul(a ^ b, 16777619), 2166136261) >>> 0;
          for (let pass = -2; pass < 5; pass++) {
            for (let i = 0; i < modes.length; i++) {
              const shift = round + pass + 2;
              const mode = modes[(shift + (shift % 2 ? -i : i) + modes.length) % modes.length];
              const guest = guests[mode], start = performance.now();
              const result = guest.run(length, count), elapsedMs = performance.now() - start;
              if (result !== sum || (guest.digest(length) >>> 0) !== digest) throw Error("Incorrect copy for " + mode);
              if (pass >= 0) rows.push({ round, pass, mode, length, count, elapsedMs });
            }
          }
        }
        return rows;
      }, { encoded, labels, round }));
    } finally { await page.close(); }
  }
  const coreSha256 = Object.fromEntries(Object.entries(cores).map(([f, bytes]) => [f, hash(bytes)]));
  await writeFile(output, JSON.stringify({ ...metadata, chromium: await browser.version(), coreSha256,
    fixtureSha256: hash(fixture), runnerSha256: hash(await readFile(import.meta.filename)), samples }, null, 2) + "\n");
} finally { await browser.close(); }
