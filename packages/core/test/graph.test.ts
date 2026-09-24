import assert from "node:assert/strict";
import test from "node:test";

import { type GraphSpec, GraphSpecSchema, parseDto, parseGraphSpec, validateGraph } from "../src/index.js";

const graph: GraphSpec = {
  schemaVersion: 1,
  id: "graph-1",
  runId: "run-1",
  depth: 0,
  revision: 1,
  nodes: [
    {
      id: "implement",
      role: "implementer",
      objective: "Make the change",
      acceptanceCriteria: ["Feature works"],
      limits: { maxTokens: 5000, maxToolCalls: 20 },
    },
    {
      id: "verify",
      role: "verifier",
      objective: "Run checks",
      acceptanceCriteria: ["Checks pass"],
      limits: { maxTokens: 2000, maxToolCalls: 10 },
    },
    {
      id: "review",
      role: "reviewer",
      objective: "Review result",
      acceptanceCriteria: ["No blocking issues"],
      limits: { maxTokens: 2000, maxToolCalls: 10 },
    },
  ],
  edges: [
    { from: "implement", to: "verify", condition: "result_ready" },
    { from: "verify", to: "review", condition: "accepted" },
  ],
};

test("accepts a valid implement, verify, review graph", () => {
  assert.deepEqual(parseGraphSpec(graph), graph);
});

test("rejects malformed planner output", () => {
  assert.throws(() => parseGraphSpec({ ...graph, nodes: [{ ...graph.nodes[0], role: "shell" }] }));
  assert.throws(() => parseGraphSpec({ ...graph, unexpectedCode: "process.exit()" }));
});

test("rejects duplicate node IDs and unknown edge endpoints", () => {
  assert.throws(() => parseGraphSpec({ ...graph, nodes: [graph.nodes[0], graph.nodes[0]] }), /duplicate_node/);
  assert.throws(
    () => parseGraphSpec({ ...graph, edges: [{ from: "implement", to: "missing", condition: "accepted" }] }),
    /unknown_edge_endpoint/,
  );
});

test("rejects cycles and self edges", () => {
  assert.throws(
    () =>
      parseGraphSpec({ ...graph, edges: [...graph.edges, { from: "review", to: "implement", condition: "accepted" }] }),
    /cycle/,
  );
  assert.throws(
    () => parseGraphSpec({ ...graph, edges: [{ from: "review", to: "review", condition: "accepted" }] }),
    /self_edge/,
  );
});

test("enforces graph ownership by depth", () => {
  assert.throws(() => parseGraphSpec({ ...graph, ownerNodeId: "implement" }), /root_has_owner/);
  assert.throws(() => parseGraphSpec({ ...graph, depth: 1 }), /child_missing_owner/);
  assert.equal(parseGraphSpec({ ...graph, depth: 2, ownerNodeId: "implement" }).depth, 2);
});

test("grandchild nodes cannot delegate further", () => {
  const nodes = graph.nodes.map((node) =>
    node.id === "implement" ? { ...node, limits: { ...node.limits, maxChildGraphs: 1 } } : node,
  );
  assert.throws(
    () => parseGraphSpec({ ...graph, depth: 2, ownerNodeId: "parent-node", nodes }),
    /delegation_beyond_depth/,
  );
});

test("collects all semantic issues at once instead of stopping at the first", () => {
  const brokenGraph = {
    ...graph,
    nodes: [graph.nodes[0], graph.nodes[0]],
    edges: [{ from: "implement", to: "implement", condition: "accepted" }],
  };
  const result = validateGraph(brokenGraph);
  assert.equal(result.ok, false);
  if (!result.ok) {
    const codes = result.issues.map((issue) => issue.code);
    assert.ok(codes.includes("duplicate_node"));
    assert.ok(codes.includes("self_edge"));
  }
});

test("AT-03: validateGraph never throws on malformed input", () => {
  assert.doesNotThrow(() => validateGraph(null));
  assert.doesNotThrow(() => validateGraph(undefined));
  assert.doesNotThrow(() => validateGraph("not a graph"));
  assert.doesNotThrow(() => validateGraph({ ...graph, nodes: "not an array" }));
  assert.doesNotThrow(() => validateGraph({ ...graph, notARealField: 1 }));
});

test("AT-03: an unsupported schema version on a graph is a typed issue, not a throw", () => {
  const result = parseDto(GraphSpecSchema, { ...graph, schemaVersion: 2 });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((issue) => issue.code === "unsupported_schema_version"));
  }
});

test("AT-03: an unknown field on a graph is a typed issue, not a throw", () => {
  assert.ok(GraphSpecSchema.safeParse(graph).success);
  assert.doesNotThrow(() => parseDto(GraphSpecSchema, { ...graph, extra: true }));
  const result = parseDto(GraphSpecSchema, { ...graph, extra: true });
  assert.equal(result.ok, false);
});
