// Add a local Rust generator to the two-version size inventory.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { sizes } from "./asset-sizes.mjs";

const web = resolve(import.meta.dirname, "..");
if (process.argv.length !== 3) throw new Error("Usage: node bench/candidate.mjs <jco-checkout>");
const checkout = resolve(process.argv[2]);
const cargoArgs = ["build", "--locked", "-p", "js-component-bindgen", "--features", "embedded-cm-runtime", "--example", "transpile"];
execFileSync("cargo", cargoArgs, { cwd: checkout, stdio: "inherit" });
const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], { cwd: checkout }));
const bin = join(metadata.target_directory, "debug/examples/transpile");
const map = readFileSync(join(web, "host/imports.txt"), "utf8").trim().split("\n").map(line => {
  const [name, symbol] = line.split(/\s+/);
  return `--map=${name}=../../../host/web-host.js#${symbol}`;
});
const inventory = JSON.parse(readFileSync(join(import.meta.dirname, "results/sizes.json")));
inventory.candidate = {
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim(),
  dirty: !!execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: checkout, encoding: "utf8" }).trim(),
  generatorSha256: createHash("sha256").update(readFileSync(bin)).digest("hex"),
};
for (const c of inventory.components) {
  const [language, demo] = c.input.path.split("/");
  const input = join(web, c.input.path);
  if (createHash("sha256").update(readFileSync(input)).digest("hex") !== c.input.sha256) {
    throw new Error(`Input changed since bench:sizes ran: ${c.input.path}`);
  }
  const directory = join(language, demo, "jco-candidate");
  const staging = mkdtempSync(join(tmpdir(), "jco-candidate-"));
  try {
    execFileSync(bin, [input, staging, `--name=${basename(input, ".wasm")}`, "--no-nodejs-compat",
      "--base64-cutoff=5000", "--namespaced-exports", ...map]);
    mkdirSync(join(web, directory), { recursive: true });
    c.variants.candidate = readdirSync(staging).filter(file => /\.(js|wasm)$/.test(file)).sort().map(file => {
      const bytes = readFileSync(join(staging, file));
      const path = join(directory, file);
      writeFileSync(join(web, path), bytes);
      return sizes(path, bytes);
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
writeFileSync(join(import.meta.dirname, "results/candidate-sizes.json"), JSON.stringify(inventory, null, 2) + "\n");
