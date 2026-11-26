// Package the checked runtime exports used by this application into one browser module.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "acorn";

export async function bundleSharedProvider(checkout, runtimeDirectory, entries) {
  const modules = new Map();
  for (const bytes of entries) {
    const ast = parse(bytes.toString("utf8"), { ecmaVersion: "latest", sourceType: "module" });
    for (const stmt of ast.body) {
      if (stmt.type !== "ImportDeclaration" || !stmt.source.value.startsWith("/runtime/")) continue;
      const path = stmt.source.value;
      if (!modules.has(path)) modules.set(path, new Set());
      for (const spec of stmt.specifiers) {
        assert.equal(spec.type, "ImportSpecifier");
        const name = spec.imported.name;
        modules.get(path).add(name);
      }
    }
  }
  return pack(checkout, runtimeDirectory, modules);
}

// Enumerate the installed package's public checked entries. This build can be
// prepared before any components are available, including components loaded later.
export async function bundleCompleteProvider(checkout, runtimeDirectory) {
  const manifest = JSON.parse(await readFile(join(checkout, "packages/jco-cm-runtime/package.json")));
  const modules = new Map();
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    // The package root aliases runtime.js. Debug entries use a different implementation.
    if (subpath === "." || subpath.startsWith("./debug")) continue;
    assert(target.default.startsWith("./dist/"));
    const file = target.default.slice("./dist/".length);
    const namespace = await import(pathToFileURL(join(runtimeDirectory, file)));
    modules.set("/runtime/" + file, new Set(Object.keys(namespace)));
  }
  return pack(checkout, runtimeDirectory, modules);
}

async function pack(checkout, runtimeDirectory, modules) {
  assert(modules.has("/runtime/intrinsics/sync.js"));
  const owners = new Map();
  for (const [path, names] of modules) {
    for (const name of names) {
      // Generated named imports can share one namespace only if they stay unambiguous.
      assert(!owners.has(name), "Ambiguous provider export " + name);
      owners.set(name, path);
    }
  }
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
