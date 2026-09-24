import { type GraphSpec, getReadyNodes, parseGraphSpec, topologicalOrder } from "@auto-pi-lot/core";

/**
 * The graph the `demo` command prints and the `trace` command's `happy-path` scenario runs
 * through the real reducer. Defined once so the two commands cannot drift apart.
 */
export const demoGraphInput: GraphSpec = {
  schemaVersion: 1,
  id: "demo-graph",
  runId: "demo-run",
  depth: 0,
  revision: 1,
  nodes: [
    {
      id: "implement",
      role: "implementer",
      objective: "Produce the requested patch",
      acceptanceCriteria: ["Patch meets the task contract"],
      limits: { maxTokens: 8000, maxToolCalls: 40 },
    },
    {
      id: "verify",
      role: "verifier",
      objective: "Collect reproducible verification evidence",
      acceptanceCriteria: ["Required checks pass against the candidate revision"],
      limits: { maxTokens: 4000, maxToolCalls: 20 },
    },
    {
      id: "review",
      role: "reviewer",
      objective: "Review the verified candidate",
      acceptanceCriteria: ["Acceptance criteria and evidence have been reviewed"],
      limits: { maxTokens: 4000, maxToolCalls: 20 },
    },
  ],
  edges: [
    { from: "implement", to: "verify", condition: "result_ready" },
    { from: "verify", to: "review", condition: "accepted" },
  ],
};

/** Prints the plan-only demo: the validated graph, its topological order, and initially ready nodes. */
export function runDemo(): void {
  const graph = parseGraphSpec(demoGraphInput);
  console.log(
    JSON.stringify(
      {
        mode: "plan-only-demo",
        graph,
        topologicalOrder: topologicalOrder(graph),
        readyNodeIds: getReadyNodes(graph, new Map()).map((node) => node.id),
      },
      null,
      2,
    ),
  );
}
