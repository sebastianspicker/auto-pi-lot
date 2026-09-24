import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";

import { canonicalJson, topologicalOrder, validateGraph } from "../src/index.js";

function buildGraphNodes(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `n${i}`,
    role: "explorer" as const,
    objective: `Node ${i}`,
    acceptanceCriteria: ["done"],
    limits: { maxTokens: 100, maxToolCalls: 5 },
  }));
}

/** A generator of forward-only edge sets (i < j) over `n` nodes: always acyclic. */
const dagArbitrary = fc.integer({ min: 1, max: 8 }).chain((n) => {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) pairs.push([i, j]);
  }
  return fc
    .array(fc.tuple(fc.boolean(), fc.constantFrom("result_ready" as const, "accepted" as const)), {
      minLength: pairs.length,
      maxLength: pairs.length,
    })
    .map((flags) => {
      const edges = pairs
        .map(([i, j], index) => ({ i, j, ...flags[index]! }))
        .filter((edge) => edge[0])
        .map((edge) => ({ from: `n${edge.i}`, to: `n${edge.j}`, condition: edge[1] }));
      return {
        schemaVersion: 1 as const,
        id: "graph",
        runId: "run",
        depth: 0 as const,
        revision: 1,
        nodes: buildGraphNodes(n),
        edges,
      };
    });
});

test("random forward-only DAGs always validate", () => {
  fc.assert(
    fc.property(dagArbitrary, (graph) => {
      const result = validateGraph(graph);
      assert.equal(result.ok, true);
    }),
  );
});

test("adding a back edge along an existing forward path yields a cycle issue", () => {
  fc.assert(
    fc.property(fc.integer({ min: 2, max: 8 }), (n) => {
      const nodes = buildGraphNodes(n);
      const forwardEdges = Array.from({ length: n - 1 }, (_, i) => ({
        from: `n${i}`,
        to: `n${i + 1}`,
        condition: "result_ready" as const,
      }));
      const graph = {
        schemaVersion: 1 as const,
        id: "graph",
        runId: "run",
        depth: 0 as const,
        revision: 1,
        nodes,
        edges: [...forwardEdges, { from: `n${n - 1}`, to: "n0", condition: "accepted" as const }],
      };
      const result = validateGraph(graph);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.issues.some((issue) => issue.code === "cycle"));
      }
    }),
  );
});

test("canonicalJson is invariant to object key insertion order", () => {
  fc.assert(
    fc.property(
      fc.dictionary(
        fc.string().filter((s) => s !== "__proto__"),
        fc.jsonValue(),
      ),
      (record) => {
        const shuffled: Record<string, unknown> = {};
        for (const key of [...Object.keys(record)].reverse()) shuffled[key] = record[key];
        assert.equal(canonicalJson(record), canonicalJson(shuffled));
      },
    ),
  );
});

test("validateGraph never throws on arbitrary input", () => {
  fc.assert(
    fc.property(fc.anything(), (input) => {
      assert.doesNotThrow(() => validateGraph(input));
    }),
  );
});

test("topologicalOrder respects every edge", () => {
  fc.assert(
    fc.property(dagArbitrary, (graph) => {
      const result = validateGraph(graph);
      assert.equal(result.ok, true);
      if (result.ok) {
        const order = topologicalOrder(result.graph);
        const position = new Map(order.map((id, index) => [id, index]));
        for (const edge of result.graph.edges) {
          assert.ok((position.get(edge.from) ?? -1) < (position.get(edge.to) ?? -1));
        }
      }
    }),
  );
});
