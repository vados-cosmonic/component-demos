// Add a local Rust generator to the two-version size inventory.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { sizes } from "./asset-sizes.mjs";

const web = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const reference = args[0] === "--reference";
const verifyWasm = args[0] === "--verify-wasm";
if (reference || verifyWasm) args.shift();
if (args.length !== 1) throw new Error("Usage: node bench/candidate.mjs [--reference | --verify-wasm] <jco-checkout>");
const version = reference ? "reference" : "candidate";
const checkout = resolve(args[0]);
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
const mappings = Object.fromEntries(readFileSync(join(web, "host/imports.txt"), "utf8").trim().split("\n").map(line => {
  const [name, symbol] = line.split(/\s+/);
  return [name, `../../../host/web-host.js#${symbol}`];
}));
const resultPath = join(import.meta.dirname, "results/candidate-sizes.json");
if (verifyWasm) {
  const measured = JSON.parse(readFileSync(resultPath));
  assert.equal(commit, measured.candidate.commit, "Check out the measured candidate first");
  const { transpileBytes } = await import(pathToFileURL(join(checkout, "packages/jco-transpile/dist/transpile.js")));
  let assets = 0;
  for (const { input, variants } of measured.components) {
    const component = readFileSync(join(web, input.path));
    assert.equal(createHash("sha256").update(component).digest("hex"), input.sha256, input.path);
    const { files } = await transpileBytes(component, {
      name: basename(input.path, ".wasm"), map: { ...mappings }, base64Cutoff: 5000,
      nodejsCompat: false, namespacedExports: true, emitTypescriptDeclarations: false,
    });
    const expected = variants.candidate;
    assert.deepEqual(Object.keys(files).sort(), expected.map(asset => basename(asset.path)).sort(), input.path);
    for (const asset of expected) {
      const native = readFileSync(join(web, asset.path));
      assert.equal(createHash("sha256").update(native).digest("hex"), asset.sha256, asset.path);
      assert(native.equals(files[basename(asset.path)]), `Different Wasm transpiler output for ${asset.path}`);
      assets++;
    }
  }
  console.log(`Native and WebAssembly transpilers match for ${assets} assets from ${measured.components.length} components at ${commit}`);
  process.exit(0);
}
// Different worktrees can produce the same Cargo example filename. Keep their
// executables separate even when CARGO_TARGET_DIR points at a shared cache.
const target = join(checkout, "target");
const cargoArgs = ["build", "--locked", "--target-dir", target, "-p", "js-component-bindgen", "--features", "embedded-cm-runtime", "--example", "transpile"];
execFileSync("cargo", cargoArgs, { cwd: checkout, stdio: "inherit" });
const bin = join(target, "debug/examples/transpile");
const map = Object.entries(mappings).map(([name, target]) => `--map=${name}=${target}`);
const inventory = JSON.parse(readFileSync(reference ? resultPath : join(import.meta.dirname, "results/sizes.json")));
inventory[version] = {
  commit,
  dirty: !!execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: checkout, encoding: "utf8" }).trim(),
  generatorSha256: createHash("sha256").update(readFileSync(bin)).digest("hex"),
};
for (const c of inventory.components) {
  const [language, demo] = c.input.path.split("/");
  const input = join(web, c.input.path);
  if (createHash("sha256").update(readFileSync(input)).digest("hex") !== c.input.sha256) {
    throw new Error(`Input changed since bench:sizes ran: ${c.input.path}`);
  }
  const directory = join(language, demo, `jco-${version}`);
  const staging = mkdtempSync(join(tmpdir(), "jco-candidate-"));
  try {
    execFileSync(bin, [input, staging, `--name=${basename(input, ".wasm")}`, "--no-nodejs-compat",
      "--base64-cutoff=5000", "--namespaced-exports", ...map]);
    mkdirSync(join(web, directory), { recursive: true });
    c.variants[version] = readdirSync(staging).filter(file => /\.(js|wasm)$/.test(file)).sort().map(file => {
      const bytes = readFileSync(join(staging, file));
      const path = join(directory, file);
      writeFileSync(join(web, path), bytes);
      return sizes(path, bytes);
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
writeFileSync(resultPath, JSON.stringify(inventory, null, 2) + "\n");
