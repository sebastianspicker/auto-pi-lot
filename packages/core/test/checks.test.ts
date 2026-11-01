import assert from "node:assert/strict";
import test from "node:test";
import { validateGraph } from "../src/graph/validate.js";
import { ProjectConfigSchema, validateReviewLimits } from "../src/run/checks.js";
import { ExecutionManifestSchema } from "../src/run/execution.js";
import { parseDto } from "../src/wire.js";

const LIMITS = { maxTokens: 1000, maxToolCalls: 10 };

function graphWith(criteria: string[], reviewed: boolean) {
  const result = validateGraph({
    schemaVersion: 1,
    id: "g",
    runId: "r",
    depth: 0,
    revision: 1,
    nodes: [
      { id: "implement", role: "implementer", objective: "change it", acceptanceCriteria: criteria, limits: LIMITS },
      ...(reviewed
        ? [{ id: "review", role: "reviewer", objective: "review it", acceptanceCriteria: ["judged"], limits: LIMITS }]
        : []),
    ],
    edges: reviewed ? [{ from: "implement", to: "review", condition: "result_ready" }] : [],
  });
  assert.ok(result.ok, JSON.stringify(result));
  return result.graph;
}

test("a reviewed producer may have at most 64 criteria of at most 2000 characters", () => {
  const many = (count: number) => Array.from({ length: count }, (_, index) => `criterion ${index}`);
  assert.deepEqual(validateReviewLimits(graphWith(many(64), true)), []);
  assert.deepEqual(validateReviewLimits(graphWith(["x".repeat(2000)], true)), []);

  const tooMany = validateReviewLimits(graphWith(many(65), true));
  assert.deepEqual(
    tooMany.map((issue) => [issue.code, issue.path]),
    [["review_limits", ["nodes", 0, "acceptanceCriteria"]]],
  );
  const tooLong = validateReviewLimits(graphWith(["ok", "x".repeat(2001)], true));
  assert.deepEqual(
    tooLong.map((issue) => [issue.code, issue.path]),
    [["review_limits", ["nodes", 0, "acceptanceCriteria", 1]]],
  );
});

test("a producer nobody reviews is not limited by review size", () => {
  const criteria = Array.from({ length: 65 }, (_, index) => `criterion ${index} ${"x".repeat(2000)}`);
  assert.deepEqual(validateReviewLimits(graphWith(criteria, false)), []);
});

test("the configuration schema rejects duplicate check profile ids", () => {
  const profile = { id: "test", command: "npm", args: ["test"] };
  const parsed = parseDto(ProjectConfigSchema, { schemaVersion: 1, checks: [profile, { ...profile }] });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.deepEqual(parsed.issues[0]?.path, ["checks", 1, "id"]);
    assert.match(parsed.issues[0]?.message ?? "", /Duplicate check profile: test/);
  }
  assert.ok(parseDto(ProjectConfigSchema, { schemaVersion: 1, checks: [profile] }).ok);
});

test("definitionDigest is allowed in an execution manifest but not in project config", () => {
  const profile = { id: "unit", command: "npm", args: ["run", "test"] };
  const manifest = (checks: object[]) => ({
    worker: "pi",
    workspace: "/w",
    checks,
    model: { provider: "p", id: "m" },
    thinkingLevel: "off",
    finalCheckIds: [],
  });
  assert.ok(ExecutionManifestSchema.safeParse(manifest([profile])).success);
  assert.ok(ExecutionManifestSchema.safeParse(manifest([{ ...profile, definitionDigest: "sha256:abc" }])).success);
  assert.ok(!ExecutionManifestSchema.safeParse(manifest([{ ...profile, extra: 1 }])).success);
  const config = { schemaVersion: 1, checks: [{ ...profile, definitionDigest: "sha256:abc" }] };
  assert.ok(!parseDto(ProjectConfigSchema, config).ok);
});
