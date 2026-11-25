import { createHash } from "node:crypto";
import { globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { transpile } from "@bytecodealliance/jco";
import { transpileBytes } from "./main/current/dist/transpile.js";

const web = resolve(import.meta.dirname, "..");
const pin = JSON.parse(readFileSync(join(import.meta.dirname, "pin.json")));
if (readFileSync(join(import.meta.dirname, "main/current/commit"), "utf8").trim() !== pin.commit) {
  throw new Error("Prepare the pinned main build with bench/setup-main.sh");
}
const baseline = JSON.parse(readFileSync(join(web, "node_modules/@bytecodealliance/jco/package.json"))).version;
const mappings = readFileSync(join(web, "host/imports.txt"), "utf8").trim().split("\n");
const map = Object.fromEntries(mappings.map(line => {
  const [name, hostExport] = line.split(/\s+/);
  return [name, `../../../host/web-host.js#${hostExport}`];
}));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function sizes(path, bytes) {
  return {
    path, bytes: bytes.length, sha256: sha256(bytes),
    gzip: gzipSync(bytes, { level: 9 }).length,
    brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
}

const components = [];
for (const input of globSync("{c,cpp,rust}/*/native/*.wasm", { cwd: web }).sort()) {
  const bytes = readFileSync(join(web, input));
  const name = basename(input, ".wasm");
  const demo = dirname(dirname(input));
  const variants = {};
  for (const [version, generate] of [["baseline", transpile], ["main", transpileBytes]]) {
    const { files } = await generate(bytes, { name, nodejsCompat: false, map: { ...map } });
    const assets = [];
    for (const [file, data] of Object.entries(files)) {
      if (!/\.(js|wasm)$/.test(file)) continue;
      const path = join(web, demo, `jco-${version}`, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data);
      assets.push(sizes(relative(web, path), Buffer.from(data)));
    }
    variants[version] = assets;
  }
  components.push({ input: sizes(input, bytes), variants });
}

const alternatives = {};
for (const pattern of ["cpp/*/{emscripten,em-js}/*", "rust/*-wasm-bindgen/*"]) {
  for (const path of globSync(pattern, { cwd: web }).sort()) {
    if (!/\.(m?js|wasm)$/.test(path)) continue;
    (alternatives[dirname(path)] ??= []).push(sizes(path, readFileSync(join(web, path))));
  }
}
mkdirSync(join(import.meta.dirname, "results"), { recursive: true });
writeFileSync(join(import.meta.dirname, "results/sizes.json"), JSON.stringify({
  baseline, main: pin.commit, components, alternatives
}, null, 2) + "\n");
console.log(`Measured ${components.length} component binaries and ${Object.keys(alternatives).length} alternatives`);
