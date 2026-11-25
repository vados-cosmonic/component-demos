import { createHash } from "node:crypto";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function sizes(path, bytes) {
  return {
    path, bytes: bytes.length, sha256: sha256(bytes),
    gzip: gzipSync(bytes, { level: 9 }).length,
    brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
}
