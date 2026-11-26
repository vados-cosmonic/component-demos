// Build all component entries for one application together, allowing Rolldown
// to share the named runtime imports across entries. The benchmark host is a
// separately served ES module already loaded before timing.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export async function bundleApp(checkout, cases, build, assets) {
  const runtime = join(checkout, "packages/jco-cm-runtime");
  const require = createRequire(join(runtime, "package.json"));
  const { rolldown, VERSION } = await import(pathToFileURL(require.resolve("rolldown")));
  const staging = await mkdtemp(join(tmpdir(), "jco-browser-app-"));
  try {
    const scope = join(staging, "node_modules/@bytecodealliance");
    await mkdir(scope, { recursive: true });
    await symlink(runtime, join(scope, "jco-cm-runtime"), "dir");
    const input = {};
    const files = new Map();
    for (const { base, name } of cases) {
      const entry = base.slice(1) + "/" + build + "-app/" + name;
      const js = join(staging, entry + ".js");
      const wasm = assets.get(base + "/" + build + "/" + name + ".core.wasm");
      await mkdir(dirname(js), { recursive: true });
      await writeFile(js, assets.get(base + "/" + build + "/" + name + ".js"));
      await writeFile(join(staging, entry + ".core.wasm"), wasm);
      input[entry] = js;
      files.set("/" + entry + ".core.wasm", wasm);
    }
    const bundle = await rolldown({
      input, platform: "browser",
      onwarn(warning, emit) {
        // Restore Jco's entry directive on the application entries below.
        if (warning.code === "MODULE_LEVEL_DIRECTIVE" && warning.message.includes("use components")) return;
        emit(warning);
      },
      external: id => id.endsWith("/host/web-host.js") || id.startsWith("node:"),
    });
    try {
      const { output } = await bundle.generate({
        banner: chunk => chunk.isEntry && build !== "release" ? '"use components";' : "",
        format: "esm", minify: true, keepNames: true, entryFileNames: "[name].js",
        chunkFileNames: "app-chunks/" + build + "/[name]-[hash].js",
      });
      const graph = {};
      for (const chunk of output) {
        assert.equal(chunk.type, "chunk");
        const url = "/" + chunk.fileName;
        files.set(url, Buffer.from(chunk.code));
        graph[url] = chunk.imports.filter(id => id !== "host/web-host.js" && !id.endsWith("/host/web-host.js") && !id.startsWith("node:")).map(id => "/" + id);
      }
      for (const [parent, children] of Object.entries(graph)) {
        for (const child of children) assert(Object.hasOwn(graph,child), parent+" -> "+child);
      }
      assert.equal(output.filter(chunk => chunk.isEntry).length, cases.length);
      return { files, graph, version: VERSION };
    } finally {
      await bundle.close();
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
