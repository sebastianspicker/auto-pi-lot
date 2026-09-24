import { getReadyNodes, parseGraphSpec, topologicalOrder } from "@auto-pi-lot/core";

const command = process.argv[2];
if (command !== "demo") {
  console.error("Usage: node packages/cli/dist/index.js demo");
  process.exitCode = 1;
} else {
  const graph = parseGraphSpec({
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
  });
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
