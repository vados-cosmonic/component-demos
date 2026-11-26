// Compare the two checked renderers against API-v1 compatibility on the same guest.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const [checkout, generator, output] = process.argv.slice(2);
assert(checkout && generator && output, "Usage: provider-loop.mjs <jco-checkout> <native-generator> <results.json>");
const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
const revision = git("rev-parse", "HEAD");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fixture = join(import.meta.dirname, "import-loop.wat");
const staging = await mkdtemp(join(tmpdir(), "jco-providers-"));
const modes = { bundled: [], external: ["--runtime=../runtime", "--cm-runtime-sync-imports"], compatibility: ["--runtime=../runtime"] };
const files = new Map();
const cores = {};
const runtime = join(checkout, "packages/jco-cm-runtime/dist");
for (const filename of await readdir(runtime, { recursive: true })) {
  if (filename.endsWith(".js")) files.set("/runtime/" + filename, await readFile(join(runtime, filename)));
}
try {
  const input = join(staging, "loop.wasm");
  execFileSync("wasm-tools", ["parse", fixture, "-o", input]);
  for (const [name, flags] of Object.entries(modes)) {
    const dir = join(staging, name);
    execFileSync(resolve(generator), [input, dir, "--name=loop", "--instantiation", "--no-nodejs-compat", "--base64-cutoff=0", ...flags]);
    for (const file of await readdir(dir)) {
      const bytes = await readFile(join(dir, file));
      files.set("/" + name + "/" + file, bytes);
      if (file.endsWith(".wasm")) {
        cores[file] ??= hash(bytes);
        assert.equal(hash(bytes), cores[file]);
      }
    }
    assert.equal(files.get("/" + name + "/loop.js").includes("../runtime/intrinsics/sync.js"), name === "external");
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN, pipe: true,
  args: process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [] });
const count = 65536;
const samples = [];
try {
  for (let round = 0; round < 7; round++) {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", req => {
      const { pathname } = new URL(req.url());
      if (pathname === "/") return req.respond({ contentType: "text/html", body: "<!doctype html>" });
      const body = files.get(pathname);
      return body ? req.respond({ contentType: pathname.endsWith(".js") ? "text/javascript" : "application/wasm", body }) : req.abort();
    });
    await page.goto("https://bench.test/");
    samples.push(...await page.evaluate(async ({ names, round, count }) => {
      class Item { constructor(value) { this.value = value; } }
      const pool = Array.from({ length: 256 }, (_, i) => new Item(i));
      const unused = () => { throw Error("Unexpected host import"); };
      const host = { api: { Item }, number: { default: n => n & 255 }, acquire: { default: n => pool[n & 255] },
        value: { default: r => r.value }, "get-text": { default: () => "x".repeat(16) },
        ...Object.fromEntries(["maybe", "text", "pixels", "send-pixels"].map(key => [key, { default: unused }])) };
      const guests = {};
      for (const name of names) {
        const { instantiate } = await import("/" + name + "/loop.js");
        guests[name] = await instantiate(file => WebAssembly.compileStreaming(fetch("/" + name + "/" + file)), host);
      }
      const rows = [];
      for (const op of ["numbers", "resources", "textReturns"]) {
        for (let pass = -2; pass < 5; pass++) {
          for (let i = 0; i < names.length; i++) {
            const name = names[(round + pass + 2 + i) % names.length];
            const run = guests[name][op];
            const start = performance.now();
            const result = op === "textReturns" ? run(count, 8) : run(count);
            const elapsedMs = performance.now() - start;
            if (result !== count * (op === "textReturns" ? 120 : 127.5)) throw Error(name + "/" + op + " checksum");
            if (pass >= 0) rows.push({ round, pass, op, name, elapsedMs });
          }
        }
      }
      return rows;
    }, { names: Object.keys(modes), round, count }));
    await page.close();
  }
  await writeFile(output, JSON.stringify({ revision, generatorSha256: hash(await readFile(generator)), fixtureSha256: hash(await readFile(fixture)),
    cores, chrome: await browser.version(), count, samples }, null, 2) + "\n");
} finally {
  await browser.close();
}
