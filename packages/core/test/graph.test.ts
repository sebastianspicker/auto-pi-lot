import assert from "node:assert/strict";
import test from "node:test";

import {
  type GraphSpec,
  GraphSpecSchema,
  parseDto,
  parseGraphSpec,
  topologicalOrder,
  validateGraph,
} from "../src/index.js";

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

test("distinct edge endpoint pairs cannot collide through ID delimiters", () => {
  const nodes = ["a->b", "c", "a", "b->c"].map((id) => ({
    ...graph.nodes[0],
    id,
    objective: `Do ${id}`,
  }));
  const result = validateGraph({
    ...graph,
    id: "graph-delimiter-ids",
    runId: "run-delimiter-ids",
    nodes,
    edges: [
      { from: "a->b", to: "c", condition: "accepted" },
      { from: "a", to: "b->c", condition: "accepted" },
    ],
  });

  assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.issues));
});

test("validates a deep acyclic graph without exhausting the call stack", () => {
  const nodeCount = 20_000;
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    ...graph.nodes[0],
    id: `node-${index}`,
    objective: `Do node ${index}`,
  }));
  const edges = Array.from({ length: nodeCount - 1 }, (_, index) => ({
    from: `node-${index}`,
    to: `node-${index + 1}`,
    condition: "accepted",
  }));

  const result = validateGraph({ ...graph, id: "graph-deep", runId: "run-deep", nodes, edges });
  assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.issues));
  if (result.ok) {
    const order = topologicalOrder(result.graph);
    assert.equal(order.length, nodeCount);
    assert.equal(order[0], "node-0");
    assert.equal(order[nodeCount - 1], `node-${nodeCount - 1}`);
  }
});

test("topological order applies declaration order when an earlier node becomes ready", () => {
  const ordered = parseGraphSpec({
    ...graph,
    id: "graph-order",
    runId: "run-order",
    nodes: [
      { ...graph.nodes[0], id: "a" },
      { ...graph.nodes[0], id: "b" },
      { ...graph.nodes[0], id: "c" },
    ],
    edges: [{ from: "a", to: "b", condition: "accepted" }],
  });

  assert.deepEqual(topologicalOrder(ordered), ["a", "b", "c"]);
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

function verifierGraph(nodeIds: string[], edges: [string, string, "result_ready" | "accepted"][]): GraphSpec {
  return {
    ...graph,
    nodes: nodeIds.map((id) => {
      const template = graph.nodes[0];
      assert.ok(template !== undefined);
      return { ...template, id };
    }),
    edges: edges.map(([from, to, condition]) => ({ from, to, condition })),
  };
}

function verifierWaitPaths(input: GraphSpec): (string | number)[][] {
  const result = validateGraph(input);
  if (result.ok) return [];
  return result.issues.filter((issue) => issue.code === "verifier_waits_for_acceptance").map((issue) => issue.path);
}

test("decision 0005: a verifying node reachable from its producer through an accepted edge is rejected", () => {
  assert.deepEqual(
    verifierWaitPaths(
      verifierGraph(
        ["p", "x", "v"],
        [
          ["p", "v", "result_ready"],
          ["p", "x", "accepted"],
          ["x", "v", "result_ready"],
        ],
      ),
    ),
    [["edges", 0]],
  );
  assert.deepEqual(
    verifierWaitPaths(
      verifierGraph(
        ["p", "x", "v"],
        [
          ["p", "v", "result_ready"],
          ["p", "x", "accepted"],
          ["x", "v", "accepted"],
        ],
      ),
    ),
    [["edges", 0]],
  );
  assert.equal(
    validateGraph(
      verifierGraph(
        ["p", "x", "v"],
        [
          ["p", "v", "result_ready"],
          ["p", "x", "result_ready"],
          ["x", "v", "result_ready"],
        ],
      ),
    ).ok,
    true,
  );
});

test("decision 0005: a verifying node that waits for its producer through another verification is rejected", () => {
  // p's acceptance waits for v's, v's for w's (w verifies v), and w starts only once p is
  // accepted. Both result_ready edges lie on that cycle.
  assert.deepEqual(
    verifierWaitPaths(
      verifierGraph(
        ["p", "v", "w"],
        [
          ["p", "v", "result_ready"],
          ["p", "w", "accepted"],
          ["v", "w", "result_ready"],
        ],
      ),
    ),
    [
      ["edges", 0],
      ["edges", 2],
    ],
  );
});

test("decision 0007: a verifying node reachable through an accepted edge is valid when nothing waits in a cycle", () => {
  // Decision 0005's path rule rejected this graph: v is reachable from p through x -> y
  // (accepted). But v's acceptance needs only x's acceptance, which needs p's result, not its
  // acceptance, so the reducer cannot deadlock.
  const result = validateGraph(
    verifierGraph(
      ["p", "x", "y", "v"],
      [
        ["p", "x", "result_ready"],
        ["x", "y", "accepted"],
        ["y", "v", "result_ready"],
        ["p", "v", "result_ready"],
      ],
    ),
  );
  assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.issues));
});

test("validates a deep chain of result_ready edges in linear time", () => {
  const nodeCount = 20_000;
  const ids = Array.from({ length: nodeCount }, (_, index) => `node-${index}`);
  const chain = verifierGraph(
    ids,
    ids.slice(1).map((to, index) => [ids[index] as string, to, "result_ready"]),
  );
  const started = performance.now();
  const result = validateGraph({ ...chain, id: "graph-deep-verified", runId: "run-deep-verified" });
  const elapsed = performance.now() - started;
  assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.issues.slice(0, 3)));
  assert.ok(elapsed < 5000, `validation took ${elapsed} ms`);
});

test("the falsifier role parses", () => {
  const falsifier = { ...graph, nodes: graph.nodes.map((node) => ({ ...node, role: "falsifier" as const })) };
  assert.equal(validateGraph(falsifier).ok, true);
});
