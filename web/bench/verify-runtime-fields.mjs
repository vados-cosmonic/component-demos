// Verify private field declarations and uses, including references through nested classes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parse, version as acorn } from "acorn";
import { basename, join } from "node:path";

const web = join(import.meta.dirname, "..");
const results = join(import.meta.dirname, "results");
const sha256 = data => createHash("sha256").update(data).digest("hex");
const inventory = readFileSync(join(results, "candidate-sizes.json"));
const { candidate, reference, components } = JSON.parse(inventory);
assert(reference && !candidate.dirty && !reference.dirty);
const git = (...args) => execFileSync("git", args, { cwd: web });
assert(process.argv[2], "Pass the component-demos commit that measured the reference");
const previousBenchmark = git("rev-parse", "--verify", "--end-of-options", process.argv[2] + "^{commit}").toString().trim();
const previousSizes = git("show", previousBenchmark + ":web/bench/results/candidate-sizes.json");
const old = JSON.parse(previousSizes);
assert.equal(old.candidate.commit, reference.commit);
const oldInputs = new Map(old.components.map(c => [c.input.path, c]));
assert.equal(oldInputs.size, components.length);
const oldMinified = JSON.parse(git("show", previousBenchmark + ":web/bench/results/minified-sizes.json"));
assert.equal(oldMinified.sizesSha256, sha256(previousSizes));
const currentMinified = JSON.parse(readFileSync(join(results, "minified-sizes.json")));
assert.equal(currentMinified.sizesSha256, sha256(inventory));

function privateIdentifiers(source) {
  const file = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const identifiers = [];
  let classCount = 0;
  function visit(node, scope) {
    if (node.type === "ClassBody") {
      const members = new Map();
      for (const member of node.body) {
        if (member.key?.type === "PrivateIdentifier") members.set(member.key.name, member);
      }
      scope = [{ id: classCount++, members }, ...scope];
    }
    if (node.type === "PrivateIdentifier") {
      const owner = scope.find(s => s.members.has(node.name));
      assert(owner, "Unbound private identifier " + node.name);
      identifiers.push({ name: node.name, start: node.start, end: node.end,
        owner: owner.id, declaration: owner.members.get(node.name) });
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) if (item?.type) visit(item, scope);
      } else if (child?.type) visit(child, scope);
    }
  }
  visit(file, []);
  return identifiers;
}

function compareScripts(original, current) {
  const left = privateIdentifiers(original), right = privateIdentifiers(current);
  assert.equal(left.length, right.length);
  const names = new Map(), inverse = new Map();
  let prevLeft = 0, prevRight = 0, changed = 0;
  for (const [i, a] of left.entries()) {
    const b = right[i];
    assert.equal(original.slice(prevLeft, a.start), current.slice(prevRight, b.start));
    assert.equal(a.owner, b.owner);
    const old = a.owner + ":" + a.name, next = b.owner + ":" + b.name;
    assert.equal(names.get(old) ?? next, next);
    assert.equal(inverse.get(next) ?? old, old);
    names.set(old, next);
    inverse.set(next, old);
    if (a.name !== b.name) {
      assert.equal(a.declaration.type, "PropertyDefinition", "Renamed a method or accessor");
      const init = a.declaration.value;
      assert(!(init?.type === "ArrowFunctionExpression" ||
        (["FunctionExpression", "ClassExpression"].includes(init?.type) && !init.id)),
      "Renamed a field that supplies a function or class name");
      changed++;
    }
    prevLeft = a.end;
    prevRight = b.end;
  }
  assert.equal(original.slice(prevLeft), current.slice(prevRight));
  return changed;
}

const inputs = [];
function readAsset(asset) {
  const bytes = readFileSync(join(web, asset.path));
  assert.equal(sha256(bytes), asset.sha256, asset.path);
  return bytes;
}
for (const { input, variants } of components) {
  const previous = new Map(variants.reference.map(f => [basename(f.path), f]));
  assert.equal(previous.size, variants.candidate.length);
  const archived = oldInputs.get(input.path);
  assert.deepEqual(archived.input, input);
  for (const asset of archived.variants.candidate) assert.equal(previous.get(basename(asset.path)).sha256, asset.sha256);
  const minified = currentMinified.components[input.path]["candidate-minified"];
  assert.deepEqual(minified, oldMinified.components[input.path]["candidate-minified"]);
  for (const asset of minified) readAsset(asset);
  let changed = 0, cores = 0;
  for (const next of variants.candidate) {
    const old = previous.get(basename(next.path));
    const before = readAsset(old), after = readAsset(next);
    if (next.path.endsWith(".js")) {
      changed += compareScripts(before.toString("utf8"), after.toString("utf8"));
    } else {
      assert(before.equals(after), next.path);
      cores++;
    }
  }
  assert(changed > 0, input.path);
  inputs.push({ input: input.path, changed, cores, minifiedAssets: minified.length });
}
writeFileSync(join(results, "runtime-fields.json"), JSON.stringify({ candidate: candidate.commit,
  reference: reference.commit, previousBenchmark, inventorySha256: sha256(inventory), acorn,
  verifierSha256: sha256(readFileSync(import.meta.filename)), inputs }, null, 2) + "\n");
console.log("Verified private field changes for " + inputs.length + " components");
