import { isCheckerRole } from "./spec.js";
import type { ValidatedGraph } from "./validate.js";

export type GraphWarningCode =
  | "isolated_node"
  | "checker_without_input"
  | "unverified_producer"
  | "checker_with_checks"
  | "checker_with_many_candidates";

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
  const candidates = new Map<string, number>();
  for (const edge of graph.edges) {
    outgoing.add(edge.from);
    incoming.add(edge.to);
    if (edge.condition === "result_ready") {
      verified.add(edge.from);
      candidates.set(edge.to, (candidates.get(edge.to) ?? 0) + 1);
    }
  }

  const warnings: GraphWarning[] = [];
  graph.nodes.forEach((node, index) => {
    const path = ["nodes", index];
    if (graph.nodes.length > 1 && !incoming.has(node.id) && !outgoing.has(node.id)) {
      warnings.push({ code: "isolated_node", path, message: `Node ${node.id} is connected to nothing` });
    }
    const checker = isCheckerRole(node.role);
    if (checker && !incoming.has(node.id)) {
      warnings.push({
        code: "checker_without_input",
        path,
        message: `${node.role} ${node.id} has no producer to check`,
      });
    }
    // The session worker reviews exactly one candidate per checker attempt (decision 0010).
    if (checker && (candidates.get(node.id) ?? 0) > 1) {
      warnings.push({
        code: "checker_with_many_candidates",
        path,
        message: `${node.role} ${node.id} verifies ${candidates.get(node.id)} producers; the session worker reviews one candidate per checker`,
      });
    }
    if (checker && (node.checks?.length ?? 0) > 0) {
      warnings.push({
        code: "checker_with_checks",
        path,
        message: `${node.role} ${node.id} declares checks, but a checker's own result is its review; the checks belong on the producer it checks`,
      });
    }
    // A checker's result is its own review receipt. Every other node needs deterministic checks or
    // a verifying node, or the evidence gate has nothing to accept it on (decision 0010).
    if (!checker && !verified.has(node.id) && (node.checks?.length ?? 0) === 0) {
      warnings.push({
        code: "unverified_producer",
        path,
        message: `${node.role} ${node.id} declares no checks and has no verifying node; the evidence gate cannot accept its result`,
      });
    }
  });
  return warnings;
}
