// Prepare matched Wasm cores and serve each generated binding in a fresh document.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { transpile } from "@bytecodealliance/jco";
import { transpileBytes } from "./main/current/dist/transpile.js";

export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const inventory = JSON.parse(await readFile(join(import.meta.dirname, "results/candidate-sizes.json")));

export async function prepareBindings({ checkout, generator, previousRef, previousGenerator, input, name }) {
  const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
  assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
  assert.equal(Boolean(previousRef), Boolean(previousGenerator));
  const previousRevision = previousRef && git("rev-parse", previousRef + "^{commit}");
  if (previousRevision) git("diff", "--exit-code", previousRevision, "HEAD", "--", "packages/jco-cm-runtime/src", "packages/jco-cm-runtime/package.json");
  assert.equal((await readFile(join(import.meta.dirname, "main/current/commit"), "utf8")).trim(), inventory.main);
  assert.equal(JSON.parse(await readFile(join(import.meta.dirname, "../node_modules/@bytecodealliance/jco/package.json"))).version, inventory.baseline);

  const options = { name, instantiation: "async", nodejsCompat: false, base64Cutoff: 0 };
  const files = new Map(), entries = {}, sizes = {};
  let cores;
  function record(label, assets) {
    const wasm = Object.fromEntries(Object.entries(assets).filter(([f]) => f.endsWith(".wasm")).map(([f,b]) => [f, Buffer.from(b)]));
    assert(Object.keys(wasm).length);
    cores ??= wasm;
    assert.deepEqual(wasm, cores, "Core modules differ for " + label);
    const entry = Buffer.from(assets[name + ".js"]);
    files.set("/" + label + "/" + name + ".js", entry);
    entries[label] = hash(entry);
    sizes[label] = { jsBytes: entry.length, gzipBytes: gzipSync(entry).length };
  }
  record("release", (await transpile(input, { ...options })).files);
  record("main", (await transpileBytes(input, { ...options })).files);
  const tmp = await mkdtemp(join(tmpdir(), "jco-bench-"));
  try {
    const source = join(tmp, "input.wasm");
    await writeFile(source, input);
    const builds = [[generator, ""]];
    if (previousGenerator) builds.push([previousGenerator, "previous-"]);
    for (const [binary, prefix] of builds) {
      for (const mode of ["bundled", "external"]) {
        const label = prefix + mode, dir = join(tmp, label);
        const flags = mode === "external" ? ["--runtime=@bytecodealliance/jco-cm-runtime"] : [];
        execFileSync(resolve(binary), [source, dir, "--name=" + name, "--instantiation", "--no-nodejs-compat", "--base64-cutoff=0", ...flags]);
        record(label, Object.fromEntries(await Promise.all((await readdir(dir)).map(async f => [f, await readFile(join(dir, f))]))));
      }
    }
  } finally { await rm(tmp, { recursive: true, force: true }); }

  const runtime = join(checkout, "packages/jco-cm-runtime/dist");
  for (const f of await readdir(runtime, { recursive: true })) {
    if (f.endsWith(".js") && !f.startsWith("debug/")) files.set("/runtime/" + f, await readFile(join(runtime, f)));
  }
  const pkg = JSON.parse(await readFile(join(runtime, "../package.json")));
  const imports = Object.fromEntries(Object.entries(pkg.exports)
    .filter(([path, entry]) => path.startsWith("./") && entry.default?.startsWith("./dist/"))
    .map(([path, entry]) => [pkg.name + path.slice(1), "/runtime/" + entry.default.slice("./dist/".length)]));
  const document = '<!doctype html><script type="importmap">' + JSON.stringify({ imports }) + '</script>';
  async function serve(page) {
    await page.setRequestInterception(true);
    page.on("request", req => {
      const path = new URL(req.url()).pathname;
      if (path === "/") return req.respond({ contentType: "text/html", body: document });
      return files.has(path) ? req.respond({ contentType: "text/javascript", body: files.get(path) }) : req.abort();
    });
    await page.goto("https://bench.test/");
  }
  return {
    cores, serve, labels: Object.keys(entries),
    metadata: { revision: git("rev-parse", "HEAD"), main: inventory.main, release: inventory.baseline,
      componentSha256: hash(input), entries, sizes, generatorSha256: hash(await readFile(generator)), previousRevision,
      previousGeneratorSha256: previousGenerator && hash(await readFile(previousGenerator)), setupSha256: hash(await readFile(import.meta.filename)) },
  };
}
