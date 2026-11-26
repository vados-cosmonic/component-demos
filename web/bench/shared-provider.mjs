// Package the checked runtime exports used by this application into one browser module.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "acorn";

export async function bundleSharedProvider(checkout, runtimeDirectory, entries) {
  const modules = new Map(), owners = new Map();
  for (const bytes of entries) {
    const ast = parse(bytes.toString("utf8"), { ecmaVersion: "latest", sourceType: "module" });
    for (const stmt of ast.body) {
      if (stmt.type !== "ImportDeclaration" || !stmt.source.value.startsWith("/runtime/")) continue;
      const path = stmt.source.value;
      if (!modules.has(path)) modules.set(path, new Set());
      for (const spec of stmt.specifiers) {
        assert.equal(spec.type, "ImportSpecifier");
        const name = spec.imported.name;
        // One ESM namespace must be able to serve every requested named export.
        assert(!owners.has(name) || owners.get(name) === path, "Ambiguous provider export " + name);
        owners.set(name, path);
        modules.get(path).add(name);
      }
    }
  }
  assert(modules.has("/runtime/intrinsics/sync.js"));
  const entry = [...modules].map(([path, names]) => {
    const file = join(runtimeDirectory, path.slice("/runtime/".length));
    return "export { " + [...names].sort().join(", ") + " } from " + JSON.stringify(file) + ";";
  }).join("\n");
  const require = createRequire(pathToFileURL(join(checkout, "packages/jco-cm-runtime/package.json")));
  const { rolldown } = await import(pathToFileURL(require.resolve("rolldown")));
  const bundle = await rolldown({
    input: "used-provider-exports", platform: "browser", external: [/^node:/],
    plugins: [{ name: "provider-entry",
      resolveId(id) { if (id === "used-provider-exports") return "\0provider-entry"; },
      load(id) { if (id === "\0provider-entry") return entry; },
    }],
  });
  try {
    const { output } = await bundle.generate({ format: "esm", codeSplitting: false, minify: true, keepNames: true });
    assert.equal(output.length, 1);
    const [chunk] = output;
    assert.equal(chunk.type, "chunk");
    assert.deepEqual(chunk.imports, []);
    assert.deepEqual([...chunk.exports].sort(), [...owners.keys()].sort());
    return { bytes: Buffer.from(chunk.code), imports: Object.fromEntries([...modules.keys()].map(
      path => [path, "/runtime/shared-provider.js"])), exports: [...owners.keys()].sort() };
  } finally {
    await bundle.close();
  }
}
