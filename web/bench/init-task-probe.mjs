// Paired edits for the three fixed table-update guests. This benchmark does not
// define an eligibility test for arbitrary components, providers or replacement cores.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { parse } from "acorn";

const startupOps = new Set([
  "(local",
  "block",
  "end",
  "br_if",
  "unreachable",
  "local.get",
  "local.tee",
  "global.get",
  "i32.add",
  "i32.const",
  "i32.eqz",
  "i32.load",
  "i32.lt_u",
  "i32.store",
  "i32.sub",
  "memory.fill",
  "select",
]);

export function inspectStarts(lang, files) {
  const core = "table_update.core.wasm";
  const inventory = {};
  for (const [name, bytes] of Object.entries(files).filter(([k]) => k.endsWith(".wasm"))) {
    const wat = execFileSync("wasm-tools", ["print", "-"], {
      input: bytes,
      encoding: "utf8",
      maxBuffer: 12_000_000,
    });
    const start = wat.match(/^  \(start ([^ )]+)\)/m)?.[1];
    const examined = {},
      ops = new Set();
    if (name === core) {
      const entry =
        lang === "rust" ? start : wat.match(/^  \(export "_initialize" \(func ([^)]+)\)\)/m)?.[1];
      assert(entry && (lang === "rust" || !start));
      // Only these named, defined Wasm functions can run. Reject unknown
      // operators, imported callees and indirect calls instead of guessing.
      const defs = new Map();
      for (const match of wat.matchAll(
        /^  \(func (\$[^ ]+) [^\n]*\n?(.*?)(?=^  \(|$(?![\s\S]))/gms,
      ))
        defs.set(match[1], match[2]);
      const todo = new Set([entry]);
      for (const func of todo) {
        assert(defs.has(func), func);
        const calls = [];
        for (const line of defs.get(func).split("\n")) {
          const [op, target] = line.split(";;")[0].trim().split(/\s+/);
          if (!op || op === ")") continue;
          ops.add(op);
          if (op === "call") {
            todo.add(target);
            calls.push(target);
          } else assert(startupOps.has(op), func + ": " + line);
        }
        examined[func] = calls;
      }
    } else if (start) {
      // The C toolchains supply one tiny start module. Its only instruction
      // is the start of function 0, imported from the main core's _initialize.
      assert.equal(lang === "rust", false);
      assert.equal(name, "table_update.core4.wasm");
      assert.equal(start, "0");
      assert.match(wat, /\(import "" "" \(func \(;0;\) \(type 0\)\)\)/);
      assert(!/^  \(func /m.test(wat));
    }
    inventory[name] = { start, examined, ops: [...ops].sort() };
  }
  return inventory;
}

function all(root, predicate) {
  const found = [];
  function visit(n) {
    if (!n || typeof n !== "object") return;
    if (predicate(n)) found.push(n);
    for (const child of Object.values(n)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child?.type) visit(child);
    }
  }
  visit(root);
  return found;
}
const one = (arr) => {
  assert.equal(arr.length, 1);
  return arr[0];
};
export function instrumentEntry(bytes, lang, build) {
  const src = Buffer.from(bytes).toString();
  const tree = parse(src, { ecmaVersion: "latest", sourceType: "module" });
  const instantiate = one(
    all(tree, (n) => n.type === "FunctionDeclaration" && n.id?.name === "instantiate"),
  );
  const initial = one(
    all(
      instantiate,
      (n) =>
        n.type === "TryStatement" &&
        n.block.body[0]?.type === "BlockStatement" &&
        src.slice(n.block.body[0].start, n.block.body[0].end).includes("<initialize>"),
    ),
  );
  const setup = initial.block.body[0];
  const buildTask = one(
    all(setup, (n) => n.type === "VariableDeclarator" && n.id.type === "ObjectPattern"),
  );
  assert.deepEqual(
    buildTask.id.properties.map((p) => p.key.name),
    ["task", "taskID", "threadID"],
  );
  const finalizer = initial.finalizer;
  const members = all(
    finalizer,
    (n) => n.type === "CallExpression" && n.callee.type === "MemberExpression",
  );
  assert.deepEqual(
    members.map((n) => n.callee.property.name),
    ["resolve", "exit"],
  );
  const clear = one(
    all(finalizer, (n) => n.type === "CallExpression" && n.callee.type === "Identifier"),
  );
  const selected = all(
    initial.block,
    (n) =>
      n.type === "SequenceExpression" &&
      n.expressions.length === 2 &&
      n.expressions[0].type === "CallExpression" &&
      n.expressions[1].type === "ObjectExpression" &&
      n.expressions[0].arguments
        .at(-1)
        ?.properties?.map((p) => p.key.name)
        .join() === "componentIdx,taskID,threadID",
  );
  assert.equal(selected.length, lang === "rust" ? 2 : 1);
  if (lang !== "rust")
    assert(src.slice(selected[0].start, selected[0].end).includes("._initialize"));
  function edit(edits) {
    let last = src.length,
      out = src;
    for (const [begin, end, text] of edits.sort((a, b) => b[0] - a[0])) {
      assert(end <= last);
      out = out.slice(0, begin) + text + out.slice(end);
      last = begin;
    }
    parse(out, { ecmaVersion: "latest", sourceType: "module" });
    return out;
  }
  const omitted = edit([
    [setup.start, setup.end, ""],
    [finalizer.start, finalizer.end, "{}"],
    ...selected.map((n) => [n.expressions[0].start, n.expressions[1].start, ""]),
  ]);
  const mark = (name) => "globalThis.__initMark(" + JSON.stringify(name) + ")";
  const timed = (node, label) => [
    node.start,
    node.end,
    "(" +
      mark(label + " start") +
      "," +
      src.slice(node.start, node.end) +
      "," +
      mark(label + " end") +
      ")",
  ];
  // The three cleanup calls are expression statements or discarded sequence
  // values. Trace the task constructor with statements to preserve its return.
  const traceEdits = [
    [instantiate.body.start + 1, instantiate.body.start + 1, mark("entered instantiate") + ";"],
    [setup.start + 1, setup.start + 1, mark("task setup start") + ";"],
    [setup.end - 1, setup.end - 1, ";" + mark("task setup end") + ";"],
    timed(clear, "clear task registers"),
    timed(members[0], "resolve task"),
    timed(members[1], "exit task"),
  ];
  // Named imports let us identify the exact factories in the external runtime.
  // Leave the internal entry's inlined factories intact and compare its enclosing phase.
  const names = new Map(
    tree.body
      .filter((n) => n.type === "ImportDeclaration")
      .flatMap((n) => n.specifiers.map((s) => [s.local.name, s.imported?.name])),
  );
  const classFactories = {};
  if (build === "external") {
    const firstLookup = src.indexOf("getCoreModule(`table_update.core.wasm`)", instantiate.start);
    assert(firstLookup > instantiate.start);
    for (const call of all(
      instantiate.body,
      (n) => n.type === "CallExpression" && n.start < firstLookup,
    )) {
      const name = names.get(call.callee?.name);
      if (!name || !/^initialize.*Class$/.test(name)) continue;
      assert(!(name in classFactories));
      classFactories[name] = true;
      // __initValue returns its second argument unchanged.
      traceEdits.push([
        call.start,
        call.end,
        "(" +
          mark(name + " start") +
          ",globalThis.__initValue(" +
          JSON.stringify(name + " end") +
          "," +
          src.slice(call.start, call.end) +
          "))",
      ]);
    }
    assert.deepEqual(Object.keys(classFactories).sort(), [
      "initializeAsyncTaskClass",
      "initializeAsyncThreadClass",
      "initializeComponentAsyncStateClass",
      "initializeRepTableClass",
    ]);
  }
  return { omitted, traced: edit(traceEdits) };
}
