import assert from "node:assert/strict";
import test from "node:test";

import { type GraphSpec, lintGraph, parseGraphSpec, type Role } from "../src/index.js";

function node(id: string, role: Role, checks?: string[]) {
  return {
    id,
    role,
    objective: `Do ${id}`,
    acceptanceCriteria: ["Done"],
    ...(checks === undefined ? {} : { checks }),
    limits: { maxTokens: 1000, maxToolCalls: 10 },
  };
}

function build(nodes: GraphSpec["nodes"], edges: GraphSpec["edges"]) {
  return parseGraphSpec({ schemaVersion: 1, id: "graph-1", runId: "run-1", depth: 0, revision: 1, nodes, edges });
}

test("a node connected to nothing in a larger graph is isolated", () => {
  const warnings = lintGraph(
    build(
      [node("a", "planner", ["lint"]), node("b", "explorer", ["lint"]), node("c", "explorer", ["lint"])],
      [{ from: "a", to: "b", condition: "accepted" }],
    ),
  );
  assert.deepEqual(
    warnings.map((warning) => [warning.code, warning.path]),
    [["isolated_node", ["nodes", 2]]],
  );
  assert.equal(warnings[0]?.message, "Node c is connected to nothing");
});

test("a checker without an incoming edge has nothing to check", () => {
  const warnings = lintGraph(
    build([node("a", "planner", ["lint"]), node("v", "verifier")], [{ from: "v", to: "a", condition: "accepted" }]),
  );
  assert.deepEqual(
    warnings.map((warning) => warning.code),
    ["checker_without_input"],
  );
  assert.equal(warnings[0]?.message, "verifier v has no producer to check");
});

test("a producer without an outgoing result_ready edge is unverified", () => {
  const warnings = lintGraph(
    build([node("a", "integrator"), node("r", "reviewer")], [{ from: "a", to: "r", condition: "accepted" }]),
  );
  assert.deepEqual(
    warnings.map((warning) => warning.code),
    ["unverified_producer"],
  );
  assert.match(warnings[0]?.message ?? "", /^integrator a declares no checks and has no verifying node/);
});

test("a producer with declared checks needs no verifying node", () => {
  const warnings = lintGraph(
    build([node("a", "integrator", ["tests"]), node("r", "reviewer")], [{ from: "a", to: "r", condition: "accepted" }]),
  );
  assert.deepEqual(warnings, []);
});

test("every non-checker role is unverified without checks or a verifying node", () => {
  const warnings = lintGraph(
    build([node("p", "planner"), node("e", "explorer")], [{ from: "p", to: "e", condition: "accepted" }]),
  );
  assert.deepEqual(
    warnings.map((warning) => [warning.code, warning.path[1]]),
    [
      ["unverified_producer", 0],
      ["unverified_producer", 1],
    ],
  );
});

test("a checker that declares checks is warned: its result is its review", () => {
  const warnings = lintGraph(
    build(
      [node("a", "implementer"), node("v", "verifier", ["tests"])],
      [{ from: "a", to: "v", condition: "result_ready" }],
    ),
  );
  assert.deepEqual(
    warnings.map((warning) => [warning.code, warning.path[1]]),
    [["checker_with_checks", 1]],
  );
});

test("the demo-shaped graph has no warnings", () => {
  const graph = build(
    [node("implement", "implementer"), node("verify", "verifier"), node("review", "reviewer")],
    [
      { from: "implement", to: "verify", condition: "result_ready" },
      { from: "verify", to: "review", condition: "accepted" },
    ],
  );
  assert.deepEqual(lintGraph(graph), []);
});

test("a single implementer is unverified but not isolated", () => {
  const warnings = lintGraph(build([node("only", "implementer")], []));
  assert.deepEqual(
    warnings.map((warning) => warning.code),
    ["unverified_producer"],
  );
});

test("warnings come in node order", () => {
  const warnings = lintGraph(build([node("i", "implementer"), node("p", "planner"), node("v", "verifier")], []));
  assert.deepEqual(
    warnings.map((warning) => [warning.code, warning.path[1]]),
    [
      ["isolated_node", 0],
      ["unverified_producer", 0],
      ["isolated_node", 1],
      ["unverified_producer", 1],
      ["isolated_node", 2],
      ["checker_without_input", 2],
    ],
  );
});
