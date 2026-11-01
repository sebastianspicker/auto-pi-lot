import assert from "node:assert/strict";
import test from "node:test";

import { parseFlags } from "../src/args.js";
import { parseValidateArgs } from "../src/validate.js";

const SPEC = { values: ["--graph"], switches: ["--quiet"], positionals: 1 };

test("parseFlags reads values, switches and the positional", () => {
  const parsed = parseFlags(["plan.json", "--graph", "g.json", "--quiet"], SPEC);
  assert.ok(parsed.ok);
  assert.equal(parsed.flags.values.get("--graph"), "g.json");
  assert.ok(parsed.flags.switches.has("--quiet"));
  assert.deepEqual(parsed.flags.positionals, ["plan.json"]);
});

test("parseFlags rejects repeated flags, missing or flag-like values and extra or missing positionals", () => {
  const cases: [readonly string[], RegExp][] = [
    [["p", "--quiet", "--quiet"], /--quiet given twice/],
    [["p", "--graph", "a", "--graph", "b"], /--graph given twice/],
    [["p", "--graph"], /incomplete argument: --graph/],
    [["p", "--graph", ""], /incomplete argument: --graph/],
    [["p", "--graph", "--quiet"], /incomplete argument: --graph/],
    [["p", "--graph=g.json"], /incomplete argument: --graph=g.json/],
    [["p", "q"], /incomplete argument: q/],
    [["p", ""], /incomplete argument: /],
    [[], /Missing argument/],
  ];
  for (const [args, error] of cases) {
    const parsed = parseFlags(args, SPEC);
    assert.equal(parsed.ok, false, args.join(" "));
    if (!parsed.ok) assert.match(parsed.error, error, args.join(" "));
  }
});

test("validate uses the shared parser: one graph file, --strict at most once", () => {
  assert.deepEqual(parseValidateArgs(["g.json", "--strict"]), { ok: true, options: { file: "g.json", strict: true } });
  assert.equal(parseValidateArgs(["g.json", "--strict", "--strict"]).ok, false);
  assert.equal(parseValidateArgs([]).ok, false);
  assert.equal(parseValidateArgs(["a.json", "b.json"]).ok, false);
});
