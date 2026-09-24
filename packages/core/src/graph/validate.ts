import { parseDto, type ValidationIssue } from "../wire.js";
import { type GraphSpec, GraphSpecSchema } from "./spec.js";

declare const validatedGraphBrand: unique symbol;
/** Only `validateGraph` produces this brand; it certifies structural and semantic checks passed. */
export type ValidatedGraph = GraphSpec & { readonly [validatedGraphBrand]: true };

function findCycleNodes(nodeIds: ReadonlySet<string>, adjacency: ReadonlyMap<string, string[]>): string[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles: string[] = [];

  function visit(nodeId: string): void {
    if (visited.has(nodeId)) return;
    if (visiting.has(nodeId)) {
      cycles.push(nodeId);
      return;
    }
    visiting.add(nodeId);
    for (const successor of adjacency.get(nodeId) ?? []) visit(successor);
    visiting.delete(nodeId);
    visited.add(nodeId);
  }

  for (const nodeId of nodeIds) visit(nodeId);
  return cycles;
}

/**
 * Never throws on any input. Collects every semantic issue rather than stopping at
 * the first: duplicate identities, unreachable endpoints, self/duplicate edges,
 * cycles, ownership-by-depth shape, and the depth-2 delegation ceiling.
 */
export function validateGraph(
  input: unknown,
): { ok: true; graph: ValidatedGraph } | { ok: false; issues: ValidationIssue[] } {
  const parsed = parseDto(GraphSpecSchema, input);
  if (!parsed.ok) return { ok: false, issues: parsed.issues };

  const graph = parsed.value;
  const issues: ValidationIssue[] = [];

  if (graph.depth === 0 && graph.ownerNodeId !== undefined) {
    issues.push({ code: "root_has_owner", path: ["ownerNodeId"], message: "Root graph cannot have an owner node" });
  }
  if (graph.depth > 0 && graph.ownerNodeId === undefined) {
    issues.push({ code: "child_missing_owner", path: ["ownerNodeId"], message: "Child graph requires an owner node" });
  }

  const nodeIds = new Set<string>();
  graph.nodes.forEach((node, index) => {
    if (nodeIds.has(node.id)) {
      issues.push({ code: "duplicate_node", path: ["nodes", index, "id"], message: `Duplicate node ID: ${node.id}` });
    } else {
      nodeIds.add(node.id);
    }
    if (graph.depth === 2 && (node.limits.maxChildGraphs ?? 0) > 0) {
      issues.push({
        code: "delegation_beyond_depth",
        path: ["nodes", index, "limits", "maxChildGraphs"],
        message: `Grandchild node cannot spawn child graphs: ${node.id}`,
      });
    }
  });

  const adjacency = new Map<string, string[]>();
  for (const nodeId of nodeIds) adjacency.set(nodeId, []);
  const edgeIds = new Set<string>();
  graph.edges.forEach((edge, index) => {
    const fromKnown = nodeIds.has(edge.from);
    const toKnown = nodeIds.has(edge.to);
    if (!fromKnown || !toKnown) {
      issues.push({
        code: "unknown_edge_endpoint",
        path: ["edges", index],
        message: `Edge references unknown node: ${edge.from} -> ${edge.to}`,
      });
    }
    if (edge.from === edge.to) {
      issues.push({ code: "self_edge", path: ["edges", index], message: `Self edge: ${edge.from}` });
    }
    const edgeKey = `${edge.from}->${edge.to}`;
    if (edgeIds.has(edgeKey)) {
      issues.push({
        code: "duplicate_edge",
        path: ["edges", index],
        message: `Duplicate edge: ${edge.from} -> ${edge.to}`,
      });
    } else {
      edgeIds.add(edgeKey);
    }
    if (fromKnown && toKnown && edge.from !== edge.to) {
      adjacency.get(edge.from)?.push(edge.to);
    }
  });

  for (const nodeId of findCycleNodes(nodeIds, adjacency)) {
    issues.push({ code: "cycle", path: ["nodes"], message: `Graph contains a cycle at ${nodeId}` });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, graph: graph as ValidatedGraph };
}

/** Kahn's algorithm; ties broken by node declaration order for a deterministic result. */
export function topologicalOrder(graph: ValidatedGraph): string[] {
  const declared = graph.nodes.map((node) => node.id);
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const nodeId of declared) {
    indegree.set(nodeId, 0);
    adjacency.set(nodeId, []);
  }
  for (const edge of graph.edges) {
    adjacency.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const done = new Set<string>();
  const order: string[] = [];
  while (order.length < declared.length) {
    const next = declared.find((nodeId) => !done.has(nodeId) && (indegree.get(nodeId) ?? 0) === 0);
    if (next === undefined) break; // defensive: a ValidatedGraph never contains a cycle
    done.add(next);
    order.push(next);
    for (const successor of adjacency.get(next) ?? []) {
      indegree.set(successor, (indegree.get(successor) ?? 0) - 1);
    }
  }
  return order;
}

/** Throwing wrapper for callers that want an exception instead of a result type. */
export function parseGraphSpec(input: unknown): ValidatedGraph {
  const result = validateGraph(input);
  if (!result.ok) {
    const message = result.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ");
    throw new Error(`Invalid graph: ${message}`);
  }
  return result.graph;
}
