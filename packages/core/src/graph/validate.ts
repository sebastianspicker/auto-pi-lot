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
 * Strongly connected components of a graph over vertices `0..adjacency.length - 1`: an
 * iterative Tarjan, so a deep graph cannot exhaust the call stack. Returns each vertex's
 * component number.
 */
function stronglyConnectedComponents(adjacency: readonly (readonly number[])[]): number[] {
  const count = adjacency.length;
  const index = Array<number>(count).fill(-1);
  const lowLink = Array<number>(count).fill(0);
  const onStack = Array<boolean>(count).fill(false);
  const component = Array<number>(count).fill(-1);
  const stack: number[] = [];
  const frames: { vertex: number; nextSuccessor: number }[] = [];
  let nextIndex = 0;
  let nextComponent = 0;

  const enter = (vertex: number): void => {
    index[vertex] = nextIndex;
    lowLink[vertex] = nextIndex;
    nextIndex += 1;
    stack.push(vertex);
    onStack[vertex] = true;
    frames.push({ vertex, nextSuccessor: 0 });
  };

  for (let root = 0; root < count; root += 1) {
    if (index[root] !== -1) continue;
    enter(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1] as { vertex: number; nextSuccessor: number };
      const vertex = frame.vertex;
      const successor = adjacency[vertex]?.[frame.nextSuccessor];

      if (successor !== undefined) {
        frame.nextSuccessor += 1;
        if (index[successor] === -1) {
          enter(successor);
        } else if (onStack[successor]) {
          lowLink[vertex] = Math.min(lowLink[vertex] as number, index[successor] as number);
        }
        continue;
      }

      frames.pop();
      if (lowLink[vertex] === index[vertex]) {
        for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
          onStack[member] = false;
          component[member] = nextComponent;
          if (member === vertex) break;
        }
        nextComponent += 1;
      }
      const parent = frames[frames.length - 1];
      if (parent !== undefined) {
        lowLink[parent.vertex] = Math.min(lowLink[parent.vertex] as number, lowLink[vertex] as number);
      }
    }
  }
  return component;
}

/**
 * Every `result_ready` edge `P -> V` (`V` verifies `P`) on which the reducer would deadlock:
 * `V`'s acceptance waits for `P`'s acceptance while `P`'s acceptance waits for `V`'s. Over the
 * wait-for graph of the events "result of N" (`R:N`) and "acceptance of N" (`A:N`): `A:N`
 * requires `R:N` and `A:V` for each verifying node `V` of `N`; `R:N` requires `R:P` for each
 * `result_ready` producer `P` and `A:P` for each `accepted` producer `P`. The edge deadlocks
 * exactly when its requirement `A:P -> A:V` lies on a cycle, that is, when `A:P` and `A:V` share
 * a strongly connected component. One linear pass over the wait-for graph finds them all. This
 * replaces decision 0005's path rule (item 1), which also rejected graphs that cannot deadlock.
 *
 * Only meaningful on an acyclic graph with known endpoints.
 */
function findVerifierWaits(graph: GraphSpec, nodeIds: ReadonlySet<string>): ValidationIssue[] {
  // Vertex `2i` is the acceptance of node `i`, vertex `2i + 1` its result.
  const position = new Map<string, number>();
  for (const nodeId of nodeIds) position.set(nodeId, position.size);
  const requires = Array.from({ length: position.size * 2 }, (_, vertex) => (vertex % 2 === 0 ? [vertex + 1] : []));
  const usable = (edge: GraphSpec["edges"][number]): boolean =>
    position.has(edge.from) && position.has(edge.to) && edge.from !== edge.to;
  for (const edge of graph.edges) {
    if (!usable(edge)) continue;
    const from = position.get(edge.from) as number;
    const to = position.get(edge.to) as number;
    if (edge.condition === "accepted") {
      requires[to * 2 + 1]?.push(from * 2);
    } else {
      requires[to * 2 + 1]?.push(from * 2 + 1);
      requires[from * 2]?.push(to * 2);
    }
  }
  const component = stronglyConnectedComponents(requires);

  const issues: ValidationIssue[] = [];
  graph.edges.forEach((edge, index) => {
    if (edge.condition !== "result_ready" || !usable(edge)) return;
    const from = position.get(edge.from) as number;
    const to = position.get(edge.to) as number;
    if (component[from * 2] !== component[to * 2]) return;
    issues.push({
      code: "verifier_waits_for_acceptance",
      path: ["edges", index],
      message: `Verifying node ${edge.to} of ${edge.from} waits for ${edge.from}'s acceptance`,
    });
  });
  return issues;
}

/**
 * Never throws on any input. Collects every semantic issue rather than stopping at
 * the first: duplicate identities, unreachable endpoints, self/duplicate edges,
 * cycles, ownership-by-depth shape, the depth-2 delegation ceiling, and (on an acyclic graph)
 * verifying nodes that would wait for their producer's acceptance.
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

  const cycleNodes = findCycleNodes(nodeIds, adjacency);
  for (const nodeId of cycleNodes) {
    issues.push({ code: "cycle", path: ["nodes"], message: `Graph contains a cycle at ${nodeId}` });
  }
  if (cycleNodes.length === 0) issues.push(...findVerifierWaits(graph, nodeIds));

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
