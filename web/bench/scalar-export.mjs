// Time a call from JS into Wasm. All renderers execute the same increment function.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { join } from "node:path";
import { parse } from "@bytecodealliance/jco";
import puppeteer from "puppeteer-core";
import { hash, inventory, prepareBindings } from "./paired-bindings.mjs";

const { positionals, values: { calculator } } = parseArgs({ allowPositionals: true, options: { calculator: { type: "string" } } });
const [checkout, generator, output, previousRef, previousGenerator] = positionals;
assert(checkout && generator && output, "Usage: scalar-export.mjs <jco-checkout> <native-generator> <results.json> [<previous-ref> <previous-generator>] [--calculator <web-relative-component-path>]");
const input = calculator ? await readFile(join(import.meta.dirname, "..", calculator)) : await parse(`(component
  (core module $guest (func (export "increment") (param i32) (result i32) (i32.add (local.get 0) (i32.const 1))))
  (core instance $i (instantiate $guest))
  (func (export "increment") (param "n" u32) (result u32) (canon lift (core func $i "increment"))))`);
if (calculator) {
  const data = inventory.components.find(c => c.input.path === calculator);
  assert.equal(hash(input), data?.input.sha256, "Calculator must match the measured input inventory");
}
const { cores, serve, labels, metadata } = await prepareBindings({ checkout, generator, previousRef, previousGenerator, input, name: "scalar" });
const core = cores["scalar.core.wasm"];
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN, pipe: true,
  args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [] });
const samples = [], count = 65536;
try {
  for (let round = 0; round < 10; round++) {
    const page = await browser.newPage();
    try {
      await serve(page);
      samples.push(...await page.evaluate(async ({ core, labels, count, round, calculator }) => {
        const module = await WebAssembly.compile(Uint8Array.fromBase64(core));
        const name = calculator ? "add" : "increment";
        const funcs = { direct: (await WebAssembly.instantiate(module)).exports[name] };
        for (const label of labels) {
          const { instantiate } = await import("/" + label + "/scalar.js");
          funcs[label] = (await instantiate(() => module, {}))[name];
        }
        const names = Object.keys(funcs), rows = [];
        for (let pass = -2; pass < 5; pass++) {
          for (let i = 0; i < names.length; i++) {
            const shift = round + pass + 2;
            const mode = names[(shift + (shift % 2 ? -i : i) + names.length) % names.length];
            const fn = funcs[mode];
            let sum = 0;
            const start = performance.now();
            if (calculator) {
              for (let n = 0; n < count; n++) sum += fn(n, 1);
            } else {
              for (let n = 0; n < count; n++) sum += fn(n);
            }
            const elapsedMs = performance.now() - start;
            if (sum !== count * (count + 1) / 2) throw Error("Incorrect sum for " + mode);
            if (pass >= 0) rows.push({ round, pass, mode, elapsedMs });
          }
        }
        return rows;
      }, { core: core.toString("base64"), labels, count, round, calculator: Boolean(calculator) }));
    } finally { await page.close(); }
  }
  await writeFile(output, JSON.stringify({ chromium: await browser.version(), ...metadata,
    fixture: calculator ?? "increment", coreSha256: hash(core),
    runnerSha256: hash(await readFile(import.meta.filename)), count, samples }, null, 2) + "\n");
} finally { await browser.close(); }
