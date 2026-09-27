import { parseDto, type ValidationIssue } from "../wire.js";
import { type GraphSpec, GraphSpecSchema } from "./spec.js";

declare const validatedGraphBrand: unique symbol;
/** Only `validateGraph` produces this brand; it certifies structural and semantic checks passed. */
export type ValidatedGraph = GraphSpec & { readonly [validatedGraphBrand]: true };

function findCycleNodes(nodeIds: ReadonlySet<string>, adjacency: ReadonlyMap<string, string[]>): string[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles: string[] = [];

  function visit(startNodeId: string): void {
    if (visited.has(startNodeId)) return;

    const stack: { nodeId: string; nextSuccessor: number }[] = [{ nodeId: startNodeId, nextSuccessor: 0 }];
    visiting.add(startNodeId);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { nodeId: string; nextSuccessor: number };
      const successors = adjacency.get(frame.nodeId) ?? [];
      const successor = successors[frame.nextSuccessor];

      if (successor !== undefined) {
        frame.nextSuccessor += 1;
        if (visited.has(successor)) continue;
        if (visiting.has(successor)) {
          cycles.push(successor);
          continue;
        }
        visiting.add(successor);
        stack.push({ nodeId: successor, nextSuccessor: 0 });
        continue;
      }

      visiting.delete(frame.nodeId);
      visited.add(frame.nodeId);
      stack.pop();
    }
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
  const edgeTargets = new Map<string, Set<string>>();
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
    let targets = edgeTargets.get(edge.from);
    if (targets === undefined) {
      targets = new Set<string>();
      edgeTargets.set(edge.from, targets);
    }
    if (targets.has(edge.to)) {
      issues.push({
        code: "duplicate_edge",
        path: ["edges", index],
        message: `Duplicate edge: ${edge.from} -> ${edge.to}`,
      });
    } else {
      targets.add(edge.to);
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
  const nodeIndex = new Map(declared.map((nodeId, index) => [nodeId, index]));
  const indegree = Array<number>(declared.length).fill(0);
  const adjacency = Array.from({ length: declared.length }, () => [] as number[]);
  for (const edge of graph.edges) {
    const fromIndex = nodeIndex.get(edge.from);
    const toIndex = nodeIndex.get(edge.to);
    if (fromIndex === undefined || toIndex === undefined) continue; // defensive: validated endpoints always exist
    adjacency[fromIndex]?.push(toIndex);
    indegree[toIndex] = (indegree[toIndex] ?? 0) + 1;
  }

  const ready: number[] = [];
  const pushReady = (nodeIndex: number): void => {
    ready.push(nodeIndex);
    let child = ready.length - 1;
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2);
      const parentValue = ready[parent] as number;
      if (parentValue <= nodeIndex) break;
      ready[child] = parentValue;
      child = parent;
    }
    ready[child] = nodeIndex;
  };
  const popReady = (): number | undefined => {
    const first = ready[0];
    const last = ready.pop();
    if (first === undefined || last === undefined) return undefined;
    if (ready.length === 0) return first;

    let parent = 0;
    while (true) {
      const left = parent * 2 + 1;
      if (left >= ready.length) break;
      const right = left + 1;
      const leftValue = ready[left] as number;
      const rightValue = right < ready.length ? (ready[right] as number) : undefined;
      const child = rightValue !== undefined && rightValue < leftValue ? right : left;
      const childValue = ready[child] as number;
      if (last <= childValue) break;
      ready[parent] = childValue;
      parent = child;
    }
    ready[parent] = last;
    return first;
  };

  for (let index = 0; index < indegree.length; index += 1) {
    if (indegree[index] === 0) pushReady(index);
  }

  const order: string[] = [];
  for (let nextIndex = popReady(); nextIndex !== undefined; nextIndex = popReady()) {
    order.push(declared[nextIndex] as string);
    for (const successorIndex of adjacency[nextIndex] ?? []) {
      const remaining = (indegree[successorIndex] ?? 0) - 1;
      indegree[successorIndex] = remaining;
      if (remaining === 0) pushReady(successorIndex);
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
