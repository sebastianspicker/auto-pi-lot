import type { NodeSpec } from "../graph/spec.js";
import { topologicalOrder, type ValidatedGraph } from "../graph/validate.js";
import { isDependencySatisfied, type NodeStatus } from "./status.js";

/** Pure readiness calculation; this does not dispatch work or allocate permits. */
export function getReadyNodes(graph: ValidatedGraph, states: ReadonlyMap<string, NodeStatus>): NodeSpec[] {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const id of states.keys()) {
    if (!nodesById.has(id)) throw new Error(`State references unknown node: ${id}`);
  }

  const statusOf = (id: string): NodeStatus => states.get(id) ?? { execution: "pending" };

  const ready = new Set<string>();
  for (const node of graph.nodes) {
    if (statusOf(node.id).execution !== "pending") continue;
    const incoming = graph.edges.filter((edge) => edge.to === node.id);
    const satisfied = incoming.every((edge) => isDependencySatisfied(edge.condition, statusOf(edge.from)));
    if (satisfied) ready.add(node.id);
  }

  return topologicalOrder(graph)
    .filter((id) => ready.has(id))
    .map((id) => nodesById.get(id))
    .filter((node): node is NodeSpec => node !== undefined);
}
