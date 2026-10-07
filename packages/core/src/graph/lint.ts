import type { ValidatedGraph } from "./validate.js";

export type GraphWarningCode = "isolated_node" | "checker_without_input" | "unverified_producer";

export interface GraphWarning {
  readonly code: GraphWarningCode;
  readonly path: (string | number)[];
  readonly message: string;
}

/**
 * Advisory only: a warning never makes a graph invalid. Pure, never throws, deterministic
 * (node order, then code order as listed in `GraphWarningCode`).
 */
export function lintGraph(graph: ValidatedGraph): GraphWarning[] {
  const incoming = new Set<string>();
  const outgoing = new Set<string>();
  const verified = new Set<string>();
  for (const edge of graph.edges) {
    outgoing.add(edge.from);
    incoming.add(edge.to);
    if (edge.condition === "result_ready") verified.add(edge.from);
  }

  const warnings: GraphWarning[] = [];
  graph.nodes.forEach((node, index) => {
    const path = ["nodes", index];
    if (graph.nodes.length > 1 && !incoming.has(node.id) && !outgoing.has(node.id)) {
      warnings.push({ code: "isolated_node", path, message: `Node ${node.id} is connected to nothing` });
    }
    const checker = node.role === "verifier" || node.role === "falsifier" || node.role === "reviewer";
    if (checker && !incoming.has(node.id)) {
      warnings.push({
        code: "checker_without_input",
        path,
        message: `${node.role} ${node.id} has no producer to check`,
      });
    }
    const producer = node.role === "implementer" || node.role === "integrator";
    if (producer && !verified.has(node.id)) {
      warnings.push({
        code: "unverified_producer",
        path,
        message: `${node.role} ${node.id} has no verifying node; its result is accepted on the gate's receipts alone`,
      });
    }
  });
  return warnings;
}
