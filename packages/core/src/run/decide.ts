import { digest } from "../canonical.js";
import { topologicalOrder, validateGraph } from "../graph/validate.js";
import type { Command } from "./commands.js";
import type {
  AcceptanceDecidedEvent,
  AttemptDispatchedEvent,
  AttemptFailedEvent,
  AttemptStoppedEvent,
  CancelRequestedEvent,
  JournalEvent,
  LeaseExpiredEvent,
  ResultProposedEvent,
  RunStartedEvent,
} from "./events.js";
import { getReadyNodes } from "./readiness.js";
import { type AttemptState, freshNodeState, isTerminalStatus, type NodeRunState, type RunState } from "./state.js";
import type { FailureCategory, NodeStatus } from "./status.js";

export type RejectionCode =
  | "duplicate_event"
  | "wrong_run"
  | "not_started"
  | "already_started"
  | "run_terminal"
  | "unknown_attempt"
  | "stale_fencing_token"
  | "invalid_transition"
  | "missing_evidence"
  | "verification_incomplete"
  | "stale_candidate"
  | "invalid_graph";

export interface Rejection {
  readonly code: RejectionCode;
  readonly message: string;
}

export interface DecideResult {
  readonly state: RunState;
  readonly commands: readonly Command[];
  readonly rejection?: Rejection;
}

function reject(state: RunState, code: RejectionCode, message: string): DecideResult {
  return { state, commands: [], rejection: { code, message } };
}

function accept(state: RunState, commands: readonly Command[] = []): DecideResult {
  return { state, commands };
}

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Every node with a `result_ready` edge from `nodeId`: its verifying nodes (decision 0005). */
function verifiersOf(state: RunState, nodeId: string): string[] {
  return (state.graph?.edges ?? [])
    .filter((edge) => edge.from === nodeId && edge.condition === "result_ready")
    .map((edge) => edge.to);
}

/** Every node with an edge into `nodeId`, whatever its condition. */
function producersOf(state: RunState, nodeId: string): string[] {
  return (state.graph?.edges ?? []).filter((edge) => edge.to === nodeId).map((edge) => edge.from);
}

function hasAttemptsLeft(state: RunState, node: NodeRunState): boolean {
  const policy = state.policy as NonNullable<RunState["policy"]>; // guaranteed by decide(): the run has started
  return node.attemptCount - node.invalidatedAttemptCount < policy.maxAttemptsPerNode;
}

/**
 * Every verifying node of `nodeId` holds an accepted result bound to `nodeId`'s current
 * attempt. Vacuously true for a node without verifying nodes.
 */
function isVerificationComplete(state: RunState, nodeId: string): boolean {
  const producer = ownValue(state.nodes, nodeId);
  if (producer === undefined || producer.activeAttemptId === null) return false;
  const candidate = producer.activeAttemptId;
  return verifiersOf(state, nodeId).every((verifierId) => {
    const verifier = ownValue(state.nodes, verifierId);
    if (verifier?.execution !== "result_ready" || verifier.disposition !== "accepted") return false;
    if (verifier.activeAttemptId === null) return false;
    const attempt = ownValue(state.attempts, verifier.activeAttemptId);
    return attempt !== undefined && ownValue(attempt.consumes, nodeId) === candidate;
  });
}

/**
 * Whether each node is evaluable: no verifying node of it can never be accepted. One that is
 * exhausted, failed or cancelled, or is itself a `verifying` producer that is not evaluable, can
 * never deliver accepted evidence, so the node's current candidate can never be accepted. One
 * pass in reverse topological order: verifying nodes lie downstream in an acyclic graph, so each
 * is settled before its producers. A node without verifying nodes is evaluable.
 */
function computeEvaluable(state: RunState): ReadonlyMap<string, boolean> {
  const evaluable = new Map<string, boolean>();
  if (state.graph === null) return evaluable;
  const verifiers = new Map<string, string[]>();
  for (const edge of state.graph.edges) {
    if (edge.condition !== "result_ready") continue;
    const list = verifiers.get(edge.from);
    if (list === undefined) verifiers.set(edge.from, [edge.to]);
    else list.push(edge.to);
  }
  for (const nodeId of topologicalOrder(state.graph).reverse()) {
    const ok = (verifiers.get(nodeId) ?? []).every((verifierId) => {
      const verifier = ownValue(state.nodes, verifierId);
      if (verifier === undefined) return true;
      if (verifier.execution === "exhausted" || verifier.execution === "failed" || verifier.execution === "cancelled") {
        return false;
      }
      return !(
        verifier.execution === "result_ready" &&
        verifier.disposition === "verifying" &&
        evaluable.get(verifierId) === false
      );
    });
    evaluable.set(nodeId, ok);
  }
  return evaluable;
}

/**
 * Fails every `pending` node that depends on `nodeId`, transitively, with `dependency_failed`.
 * Nodes in any other execution state are left alone and the walk does not continue through
 * them: a node that already started keeps running until its own outcome.
 */
function failDependents(state: RunState, nodeId: string): RunState["nodes"] {
  if (state.graph === null) return state.nodes;
  const edges = state.graph.edges;
  let nodes = state.nodes;
  const visited = new Set<string>([nodeId]);
  const queue = [nodeId];
  for (let producer = queue.shift(); producer !== undefined; producer = queue.shift()) {
    for (const edge of edges) {
      if (edge.from !== producer || visited.has(edge.to)) continue;
      visited.add(edge.to);
      const dependent = ownValue(nodes, edge.to);
      if (dependent === undefined || dependent.execution !== "pending") continue;
      nodes = {
        ...nodes,
        [edge.to]: { ...dependent, execution: "failed" as const, failureCategory: "dependency_failed" as const },
      };
      queue.push(edge.to);
    }
  }
  return nodes;
}

/**
 * A retry puts a node back to `pending`. If one of its producers has meanwhile been
 * exhausted (or failed), the node can never become ready again, so it fails with
 * `dependency_failed` instead, and so do its own pending dependents.
 */
function retryOrFailDependency(state: RunState, nodeId: string, retried: NodeRunState): RunState["nodes"] {
  const blocked = state.graph?.edges.some((edge) => {
    const producer = ownValue(state.nodes, edge.from);
    return edge.to === nodeId && (producer?.execution === "exhausted" || producer?.execution === "failed");
  });
  if (!blocked) return { ...state.nodes, [nodeId]: retried };
  const failed = { ...retried, execution: "failed" as const, failureCategory: "dependency_failed" as const };
  return failDependents({ ...state, nodes: { ...state.nodes, [nodeId]: failed } }, nodeId);
}

/**
 * Invalidates the current work of every node that consumed `attemptId` of `producerId`, and,
 * transitively, the work built on an invalidated result (decision 0005): a held reservation is
 * dropped, an in-flight attempt is asked to stop, and a proposed or accepted result returns its
 * node to `pending` with disposition `invalidated`. During cancellation, affected nodes settle
 * as `cancelled` instead (decision 0009). Pending and settled nodes are left alone.
 */
function invalidateConsumers(
  state: RunState,
  producerId: string,
  attemptId: string,
): { state: RunState; commands: Command[] } {
  if (state.graph === null) return { state, commands: [] };
  let current = state;
  const commands: Command[] = [];
  for (const edge of state.graph.edges) {
    if (edge.from !== producerId) continue;
    const consumer = ownValue(current.nodes, edge.to);
    if (consumer === undefined) continue;

    if (consumer.execution === "ready") {
      if (consumer.reservedConsumes === null || ownValue(consumer.reservedConsumes, producerId) !== attemptId) continue;
      // No attempt record exists yet; the host's later `attempt_dispatched` for it is rejected.
      current = {
        ...current,
        nodes: {
          ...current.nodes,
          [edge.to]: {
            ...consumer,
            execution: current.status === "cancelling" ? ("cancelled" as const) : ("pending" as const),
            reservedAttemptId: null,
            reservedFencingToken: null,
            reservedConsumes: null,
          },
        },
        permitsInUse: current.permitsInUse - 1,
      };
      continue;
    }

    if (consumer.activeAttemptId === null) continue;
    const consumerAttemptId = consumer.activeAttemptId;
    const attempt = ownValue(current.attempts, consumerAttemptId);
    if (attempt === undefined || ownValue(attempt.consumes, producerId) !== attemptId) continue;

    if (consumer.execution === "running") {
      // The node keeps its permit until the worker reports how the attempt ended.
      if (attempt.status === "dispatched") commands.push({ type: "cancel_attempt", attemptId: consumerAttemptId });
      const status = attempt.status === "dispatched" ? ("stopping" as const) : attempt.status;
      current = {
        ...current,
        attempts: { ...current.attempts, [consumerAttemptId]: { ...attempt, status, invalidated: true } },
      };
    } else if (consumer.execution === "result_ready") {
      current = {
        ...current,
        attempts: {
          ...current.attempts,
          [consumerAttemptId]: { ...attempt, status: "invalidated" as const, invalidated: true },
        },
        nodes: {
          ...current.nodes,
          [edge.to]: {
            ...consumer,
            execution: current.status === "cancelling" ? ("cancelled" as const) : ("pending" as const),
            disposition: "invalidated" as const,
            activeAttemptId: null,
            acceptanceRequested: false,
            invalidatedAttemptCount: consumer.invalidatedAttemptCount + 1,
          },
        },
      };
      const nested = invalidateConsumers(current, edge.to, consumerAttemptId);
      current = nested.state;
      commands.push(...nested.commands);
    }
  }
  return { state: current, commands };
}

function toNodeStatusMap(nodes: Readonly<Record<string, NodeRunState>>): Map<string, NodeStatus> {
  const map = new Map<string, NodeStatus>();
  for (const [nodeId, node] of Object.entries(nodes)) {
    map.set(
      nodeId,
      node.disposition === null
        ? { execution: node.execution }
        : { execution: node.execution, disposition: node.disposition },
    );
  }
  return map;
}

// ---------------------------------------------------------------------------------------
// Per-event handlers. Each is total over its own event type and never touches
// `appliedEventIds`, dispatch, or completion: `decide` composes those centrally below.
// ---------------------------------------------------------------------------------------

function handleRunStarted(state: RunState, event: RunStartedEvent): DecideResult {
  if (state.status !== "not_started") {
    return reject(state, "already_started", `Run ${event.runId} has already started`);
  }
  const validated = validateGraph(event.graph);
  if (!validated.ok) {
    const message = validated.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ");
    return reject(state, "invalid_graph", message);
  }
  if (validated.graph.runId !== event.runId) {
    return reject(
      state,
      "wrong_run",
      `Graph run ${JSON.stringify(validated.graph.runId)} does not match event run ${JSON.stringify(event.runId)}`,
    );
  }

  const nodes: Record<string, NodeRunState> = Object.fromEntries(
    validated.graph.nodes.map((node) => [node.id, freshNodeState()]),
  );

  return accept({
    runId: event.runId,
    status: "running",
    graph: validated.graph,
    policy: { maxConcurrent: event.policy.maxConcurrent, maxAttemptsPerNode: event.policy.maxAttemptsPerNode },
    nodes,
    attempts: {},
    permitsInUse: 0,
    appliedEventIds: state.appliedEventIds,
    lastFencingToken: 0,
  });
}

function handleAttemptDispatched(state: RunState, event: AttemptDispatchedEvent): DecideResult {
  const node = ownValue(state.nodes, event.nodeId);
  if (node === undefined) return reject(state, "invalid_transition", `Unknown node: ${event.nodeId}`);
  if (
    node.execution !== "ready" ||
    node.reservedAttemptId !== event.attemptId ||
    node.reservedFencingToken !== event.fencingToken
  ) {
    return reject(
      state,
      "invalid_transition",
      `No matching reservation for attempt ${event.attemptId} on node ${event.nodeId}`,
    );
  }

  const nodes = {
    ...state.nodes,
    [event.nodeId]: {
      ...node,
      execution: "running" as const,
      disposition: null,
      attemptCount: node.attemptCount + 1,
      activeAttemptId: event.attemptId,
      reservedAttemptId: null,
      reservedFencingToken: null,
      reservedConsumes: null,
    },
  };
  const attempts: Record<string, AttemptState> = {
    ...state.attempts,
    [event.attemptId]: {
      nodeId: event.nodeId,
      fencingToken: event.fencingToken,
      status: "dispatched",
      consumes: node.reservedConsumes ?? {},
      invalidated: false,
    },
  };
  return accept({ ...state, nodes, attempts });
}

function handleResultProposed(state: RunState, event: ResultProposedEvent): DecideResult {
  const attempt = ownValue(state.attempts, event.attemptId);
  if (attempt === undefined) return reject(state, "unknown_attempt", `Unknown attempt: ${event.attemptId}`);
  if (attempt.fencingToken !== event.fencingToken) {
    return reject(state, "stale_fencing_token", `Stale fencing token on attempt ${event.attemptId}`);
  }
  if (attempt.invalidated && attempt.status === "stopping") {
    return reject(
      state,
      "stale_candidate",
      `Attempt ${event.attemptId} consumed a producer result that is no longer current`,
    );
  }
  if (attempt.status !== "dispatched") {
    return reject(state, "invalid_transition", `Attempt ${event.attemptId} is not awaiting a result`);
  }

  // A producer with verifying nodes waits in `verifying`; `requestDueAcceptances` asks for its
  // acceptance once every verifying node holds an accepted result bound to this attempt.
  const node = state.nodes[attempt.nodeId] as NodeRunState;
  const verified = verifiersOf(state, attempt.nodeId).length > 0;
  const nodes = {
    ...state.nodes,
    [attempt.nodeId]: {
      ...node,
      execution: "result_ready" as const,
      disposition: verified ? ("verifying" as const) : ("unverified" as const),
      acceptanceRequested: !verified,
    },
  };
  const attempts = { ...state.attempts, [event.attemptId]: { ...attempt, status: "result_ready" as const } };
  const commands: Command[] = verified
    ? []
    : [{ type: "evaluate_acceptance", nodeId: attempt.nodeId, attemptId: event.attemptId }];
  return accept({ ...state, nodes, attempts, permitsInUse: state.permitsInUse - 1 }, commands);
}

function handleAcceptanceDecided(state: RunState, event: AcceptanceDecidedEvent): DecideResult {
  const attempt = ownValue(state.attempts, event.attemptId);
  if (attempt === undefined) return reject(state, "unknown_attempt", `Unknown attempt: ${event.attemptId}`);
  if (attempt.nodeId !== event.nodeId) {
    return reject(state, "invalid_transition", `Attempt ${event.attemptId} does not belong to node ${event.nodeId}`);
  }
  if (attempt.status !== "result_ready") {
    return reject(
      state,
      "invalid_transition",
      `Attempt ${event.attemptId} has already been decided or has no pending result (status: ${attempt.status})`,
    );
  }

  if (event.decision === "accepted" && event.receiptIds.length === 0) {
    return reject(state, "missing_evidence", `An accepted decision for attempt ${event.attemptId} cites no receipt`);
  }
  // A rejection may arrive at any time while the result is pending (fail fast); an acceptance
  // only once every verifying node holds an accepted result bound to this attempt.
  if (event.decision === "accepted" && !isVerificationComplete(state, event.nodeId)) {
    return reject(
      state,
      "verification_incomplete",
      `Attempt ${event.attemptId} cannot be accepted before every verifying node of ${event.nodeId} accepted it`,
    );
  }

  const node = state.nodes[event.nodeId] as NodeRunState;

  if (event.decision === "accepted") {
    const attempts = { ...state.attempts, [event.attemptId]: { ...attempt, status: "accepted" as const } };
    // An accepted attempt has repaired any earlier rejection: a later dispatch is no repair.
    const nodes = {
      ...state.nodes,
      [event.nodeId]: { ...node, disposition: "accepted" as const, lastRejection: null },
    };
    return accept({ ...state, nodes, attempts });
  }

  // Rejected while cancelling: the run is winding down, so this attempt's outcome settles
  // the node directly instead of retrying — a retry would need a new permit and dispatch,
  // both forbidden once cancellation has started. Consumers still lose trust in this result.
  if (state.status === "cancelling") {
    const attempts = { ...state.attempts, [event.attemptId]: { ...attempt, status: "rejected" as const } };
    const nodes = {
      ...state.nodes,
      [event.nodeId]: {
        ...node,
        execution: "cancelled" as const,
        disposition: "rejected" as const,
        acceptanceRequested: false,
      },
    };
    const invalidated = invalidateConsumers({ ...state, nodes, attempts }, event.nodeId, event.attemptId);
    return accept(invalidated.state, invalidated.commands);
  }

  // Rejected. Every node that consumed this attempt is invalidated, transitively (decision
  // 0005), and the next dispatch of this node carries the rejection as `repairOf`.
  const lastRejection = { attemptId: event.attemptId, receiptIds: [...event.receiptIds] };
  if (hasAttemptsLeft(state, node)) {
    const retried = {
      ...node,
      execution: "pending" as const,
      disposition: null,
      activeAttemptId: null,
      acceptanceRequested: false,
      lastRejection,
    };
    const invalidated = invalidateConsumers(
      {
        ...state,
        attempts: { ...state.attempts, [event.attemptId]: { ...attempt, status: "superseded" as const } },
        nodes: { ...state.nodes, [event.nodeId]: retried },
      },
      event.nodeId,
      event.attemptId,
    );
    const nodes = retryOrFailDependency(invalidated.state, event.nodeId, retried);
    return accept({ ...invalidated.state, nodes }, invalidated.commands);
  }

  const invalidated = invalidateConsumers(
    {
      ...state,
      attempts: { ...state.attempts, [event.attemptId]: { ...attempt, status: "rejected" as const } },
      nodes: {
        ...state.nodes,
        [event.nodeId]: {
          ...node,
          execution: "exhausted" as const,
          disposition: "rejected" as const,
          failureCategory: "review_rejected" as const,
          acceptanceRequested: false,
          lastRejection,
        },
      },
    },
    event.nodeId,
    event.attemptId,
  );
  const nodes = failDependents(invalidated.state, event.nodeId);
  return accept({ ...invalidated.state, nodes }, invalidated.commands);
}

/**
 * How an invalidated attempt's node continues once the attempt has ended: cancelled while the
 * run is cancelling, otherwise back to `pending` without spending its retry allowance.
 */
function endInvalidatedAttempt(state: RunState, node: NodeRunState, nodeId: string): RunState["nodes"] {
  if (state.status === "cancelling") {
    return { ...state.nodes, [nodeId]: { ...node, execution: "cancelled" as const, activeAttemptId: null } };
  }
  return retryOrFailDependency(state, nodeId, {
    ...node,
    execution: "pending" as const,
    activeAttemptId: null,
    failureCategory: null,
    invalidatedAttemptCount: node.invalidatedAttemptCount + 1,
  });
}

/** Shared by `attempt_failed` and `lease_expired`: both release a permit and retry-or-exhaust. */
function handleAttemptTerminated(
  state: RunState,
  attemptId: string,
  fencingToken: number,
  category: FailureCategory,
): DecideResult {
  const attempt = ownValue(state.attempts, attemptId);
  if (attempt === undefined) return reject(state, "unknown_attempt", `Unknown attempt: ${attemptId}`);
  if (attempt.fencingToken !== fencingToken) {
    return reject(state, "stale_fencing_token", `Stale fencing token on attempt ${attemptId}`);
  }
  if (attempt.status !== "dispatched" && attempt.status !== "stopping") {
    return reject(state, "invalid_transition", `Attempt ${attemptId} is not active`);
  }

  const node = state.nodes[attempt.nodeId] as NodeRunState;
  const attempts = { ...state.attempts, [attemptId]: { ...attempt, status: "failed" as const } };
  const permitsInUse = state.permitsInUse - 1;

  if (attempt.invalidated) {
    const nodes = endInvalidatedAttempt({ ...state, attempts }, node, attempt.nodeId);
    return accept({ ...state, nodes, attempts, permitsInUse });
  }

  if (state.status === "cancelling") {
    const nodes = {
      ...state.nodes,
      [attempt.nodeId]: { ...node, execution: "cancelled" as const, activeAttemptId: null },
    };
    return accept({ ...state, nodes, attempts, permitsInUse });
  }

  if (hasAttemptsLeft(state, node)) {
    const nodes = retryOrFailDependency(state, attempt.nodeId, {
      ...node,
      execution: "pending" as const,
      activeAttemptId: null,
      failureCategory: null,
    });
    return accept({ ...state, nodes, attempts, permitsInUse });
  }

  const nodes = failDependents(
    {
      ...state,
      nodes: {
        ...state.nodes,
        [attempt.nodeId]: {
          ...node,
          execution: "exhausted" as const,
          activeAttemptId: null,
          failureCategory: category,
        },
      },
    },
    attempt.nodeId,
  );
  return accept({ ...state, nodes, attempts, permitsInUse });
}

function handleAttemptFailed(state: RunState, event: AttemptFailedEvent): DecideResult {
  return handleAttemptTerminated(state, event.attemptId, event.fencingToken, event.category);
}

function handleLeaseExpired(state: RunState, event: LeaseExpiredEvent): DecideResult {
  return handleAttemptTerminated(state, event.attemptId, event.fencingToken, "lease_lost");
}

function handleCancelRequested(state: RunState, _event: CancelRequestedEvent): DecideResult {
  if (state.status !== "running") {
    return reject(state, "invalid_transition", `Run is not running (status: ${state.status})`);
  }

  let nodes = state.nodes;
  let attempts = state.attempts;
  let permitsInUse = state.permitsInUse;
  const commands: Command[] = [];

  for (const [nodeId, node] of Object.entries(state.nodes)) {
    if (node.execution === "running" && node.activeAttemptId !== null) {
      const attempt = attempts[node.activeAttemptId] as AttemptState;
      // An invalidation already asked this attempt to stop; its `attempt_stopped` now lands
      // while cancelling and settles the node as `cancelled`.
      if (attempt.status === "stopping") continue;
      attempts = { ...attempts, [node.activeAttemptId]: { ...attempt, status: "stopping" as const } };
      commands.push({ type: "cancel_attempt", attemptId: node.activeAttemptId });
    } else if (node.execution === "ready") {
      // Drop an unconfirmed reservation: no `attempt_dispatched` ever persisted for it.
      nodes = {
        ...nodes,
        [nodeId]: {
          ...node,
          execution: "cancelled" as const,
          reservedAttemptId: null,
          reservedFencingToken: null,
          reservedConsumes: null,
        },
      };
      permitsInUse -= 1;
    } else if (node.execution === "pending") {
      nodes = { ...nodes, [nodeId]: { ...node, execution: "cancelled" as const } };
    }
  }

  return accept({ ...state, status: "cancelling", nodes, attempts, permitsInUse }, commands);
}

function handleAttemptStopped(state: RunState, event: AttemptStoppedEvent): DecideResult {
  const attempt = ownValue(state.attempts, event.attemptId);
  if (attempt === undefined) return reject(state, "unknown_attempt", `Unknown attempt: ${event.attemptId}`);
  if (attempt.status !== "stopping")
    return reject(state, "invalid_transition", `Attempt ${event.attemptId} is not stopping`);

  const node = state.nodes[attempt.nodeId] as NodeRunState;
  const attempts = { ...state.attempts, [event.attemptId]: { ...attempt, status: "stopped" as const } };
  if (attempt.invalidated) {
    const nodes = endInvalidatedAttempt({ ...state, attempts }, node, attempt.nodeId);
    return accept({ ...state, nodes, attempts, permitsInUse: state.permitsInUse - 1 });
  }
  const nodes = {
    ...state.nodes,
    [attempt.nodeId]: { ...node, execution: "cancelled" as const, activeAttemptId: null },
  };
  return accept({ ...state, nodes, attempts, permitsInUse: state.permitsInUse - 1 });
}

// ---------------------------------------------------------------------------------------
// Dispatch loop and completion: applied by `decide` after every accepted event.
// ---------------------------------------------------------------------------------------

/**
 * While the run is `running`: a `verifying` producer that can no longer be evaluated (a
 * verifying node ended without a result) can never be accepted, so its pending dependents fail
 * with `dependency_failed`. Repeated until nothing changes, since a failed node can in turn be
 * the verifying node of another producer.
 */
function settleUnacceptable(state: RunState): RunState {
  if (state.status !== "running") return state;
  let current = state;
  let evaluable = computeEvaluable(current);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [nodeId, node] of Object.entries(current.nodes)) {
      if (node.execution !== "result_ready" || node.disposition !== "verifying" || evaluable.get(nodeId) !== false) {
        continue;
      }
      const nodes = failDependents(current, nodeId);
      if (nodes !== current.nodes) {
        current = { ...current, nodes };
        evaluable = computeEvaluable(current);
        changed = true;
      }
    }
  }
  return current;
}

/**
 * While the run is `running` or `cancelling`: emit `evaluate_acceptance` for every `verifying`
 * producer whose verification just became complete. A request whose verification became
 * incomplete again (a verifying node was invalidated through another producer) is withdrawn,
 * so it is asked for again once the verifying node is accepted anew.
 */
function requestDueAcceptances(state: RunState): { state: RunState; commands: Command[] } {
  if (state.status !== "running" && state.status !== "cancelling") return { state, commands: [] };
  let nodes = state.nodes;
  const commands: Command[] = [];
  for (const [nodeId, node] of Object.entries(state.nodes)) {
    if (node.execution !== "result_ready" || node.disposition !== "verifying" || node.activeAttemptId === null) {
      continue;
    }
    const complete = isVerificationComplete(state, nodeId);
    if (complete && !node.acceptanceRequested) {
      nodes = { ...nodes, [nodeId]: { ...node, acceptanceRequested: true } };
      commands.push({ type: "evaluate_acceptance", nodeId, attemptId: node.activeAttemptId });
    } else if (!complete && node.acceptanceRequested) {
      nodes = { ...nodes, [nodeId]: { ...node, acceptanceRequested: false } };
    }
  }
  return { state: nodes === state.nodes ? state : { ...state, nodes }, commands };
}

/**
 * While the run is `running` and permits remain, reserve the next ready node's attempt and
 * emit a `dispatch` command. This only reserves (`execution: "ready"`, permit held): it
 * never marks a node `running` itself, so a second `decide` call before the host persists
 * the matching `attempt_dispatched` event will not reserve the same node again (it is no
 * longer `pending`, so `getReadyNodes` skips it).
 */
function runDispatchLoop(state: RunState): { state: RunState; commands: Command[] } {
  if (state.status !== "running" || state.graph === null || state.policy === null) {
    return { state, commands: [] };
  }

  const graph = state.graph;
  const policy = state.policy;
  const commands: Command[] = [];
  let nodes = state.nodes;
  let permitsInUse = state.permitsInUse;
  let lastFencingToken = state.lastFencingToken;

  for (;;) {
    if (permitsInUse >= policy.maxConcurrent) break;
    const ready = getReadyNodes(graph, toNodeStatusMap(nodes));
    const next = ready[0];
    if (next === undefined) break;

    const nodeState = nodes[next.id] as NodeRunState;
    // Bind the attempt to every producer's current attempt; a ready node's producers all have one.
    // Built from entries, never by indexed assignment: a node id such as `__proto__` must become
    // an own key of the record, not a prototype write that silently drops the binding.
    const bindings: [string, string][] = [];
    for (const producerId of producersOf(state, next.id)) {
      const producerAttemptId = ownValue(nodes, producerId)?.activeAttemptId;
      if (producerAttemptId !== undefined && producerAttemptId !== null) bindings.push([producerId, producerAttemptId]);
    }
    const consumes: Record<string, string> = Object.fromEntries(bindings);
    // A dropped reservation does not advance `attemptCount`, so the fencing token keeps the
    // attempt id unique per reservation.
    const attemptNumber = nodeState.attemptCount + 1;
    lastFencingToken += 1;
    const fencingToken = lastFencingToken;
    const attemptId = digest({ runId: state.runId, nodeId: next.id, attempt: attemptNumber, fencingToken });

    nodes = {
      ...nodes,
      [next.id]: {
        ...nodeState,
        execution: "ready" as const,
        reservedAttemptId: attemptId,
        reservedFencingToken: fencingToken,
        reservedConsumes: consumes,
      },
    };
    permitsInUse += 1;
    commands.push({
      type: "dispatch",
      nodeId: next.id,
      attemptId,
      fencingToken,
      consumes: { ...consumes },
      repairOf:
        nodeState.lastRejection === null
          ? null
          : { attemptId: nodeState.lastRejection.attemptId, receiptIds: [...nodeState.lastRejection.receiptIds] },
    });
  }

  return { state: { ...state, nodes, permitsInUse, lastFencingToken }, commands };
}

function isProgressImpossible(state: RunState): boolean {
  if (state.graph === null) return false;
  const nodes = Object.values(state.nodes);
  const inFlight = nodes.some((node) => node.execution === "running" || node.execution === "ready");
  if (inFlight || hasOutstandingAcceptance(state)) return false;
  if (getReadyNodes(state.graph, toNodeStatusMap(state.nodes)).length > 0) return false;
  return nodes.some((node) => node.execution === "failed" || node.execution === "exhausted");
}

function allAccepted(state: RunState): boolean {
  const nodes = Object.values(state.nodes);
  return (
    nodes.length > 0 && nodes.every((node) => node.execution === "result_ready" && node.disposition === "accepted")
  );
}

/**
 * A node whose proposed result still awaits (or is mid-) an acceptance decision and can still
 * get one: a `verifying` producer whose verifying node ended without a result cannot.
 */
function hasOutstandingAcceptance(state: RunState): boolean {
  const evaluable = computeEvaluable(state);
  return Object.entries(state.nodes).some(
    ([nodeId, node]) =>
      node.execution === "result_ready" &&
      (node.disposition === "unverified" || node.disposition === "verifying") &&
      evaluable.get(nodeId) !== false,
  );
}

function checkCompletion(state: RunState, commands: readonly Command[]): DecideResult {
  if (state.status === "running") {
    if (allAccepted(state)) {
      return accept({ ...state, status: "succeeded" }, [...commands, { type: "complete_run", status: "succeeded" }]);
    }
    if (isProgressImpossible(state)) {
      return accept({ ...state, status: "failed" }, [...commands, { type: "complete_run", status: "failed" }]);
    }
  } else if (state.status === "cancelling" && state.permitsInUse === 0 && !hasOutstandingAcceptance(state)) {
    return accept({ ...state, status: "cancelled" }, [...commands, { type: "complete_run", status: "cancelled" }]);
  }
  return accept(state, commands);
}

function guardEvent(state: RunState, event: JournalEvent): DecideResult | null {
  // Defensive: keeps `decide` total even if a caller casts non-object garbage past the
  // `JournalEvent` type instead of going through `parseJournalEvent` first.
  if (typeof event !== "object" || event === null) {
    return reject(state, "invalid_transition", `Malformed event: ${JSON.stringify(event)}`);
  }
  if (ownValue(state.appliedEventIds, event.eventId) === true) {
    return reject(state, "duplicate_event", `Event already applied: ${event.eventId}`);
  }
  if (event.type === "run_started") return null; // handleRunStarted checks already_started itself
  if (state.status === "not_started") {
    return reject(state, "not_started", "Run has not started");
  }
  if (state.runId !== event.runId) {
    return reject(
      state,
      "wrong_run",
      `Event run ${JSON.stringify(event.runId)} does not match current run ${JSON.stringify(state.runId)}`,
    );
  }
  if (isTerminalStatus(state.status)) {
    return reject(state, "run_terminal", `Run is terminal (status: ${state.status})`);
  }
  return null;
}

function applyHandler(state: RunState, event: JournalEvent): DecideResult {
  switch (event.type) {
    case "run_started":
      return handleRunStarted(state, event);
    case "attempt_dispatched":
      return handleAttemptDispatched(state, event);
    case "result_proposed":
      return handleResultProposed(state, event);
    case "acceptance_decided":
      return handleAcceptanceDecided(state, event);
    case "attempt_failed":
      return handleAttemptFailed(state, event);
    case "lease_expired":
      return handleLeaseExpired(state, event);
    case "cancel_requested":
      return handleCancelRequested(state, event);
    case "attempt_stopped":
      return handleAttemptStopped(state, event);
    default:
      // Defensive: keeps `decide` total even if a caller casts malformed data past the
      // `JournalEvent` type instead of going through `parseJournalEvent` first.
      return reject(state, "invalid_transition", `Unknown event type: ${String((event as { type?: unknown }).type)}`);
  }
}

/**
 * Total pure reducer: never throws. A rejection returns the original `state` reference
 * unchanged. On success, marks the event applied, fails the dependents of producers that can
 * no longer be accepted, requests due acceptances, runs the dispatch loop, then checks for run
 * completion, all before returning to the caller.
 */
export function decide(state: RunState, event: JournalEvent): DecideResult {
  const guarded = guardEvent(state, event);
  if (guarded !== null) return guarded;

  const outcome = applyHandler(state, event);
  if (outcome.rejection !== undefined) return outcome;

  const applied: RunState = {
    ...outcome.state,
    appliedEventIds: { ...outcome.state.appliedEventIds, [event.eventId]: true },
  };
  const requested = requestDueAcceptances(settleUnacceptable(applied));
  const dispatched = runDispatchLoop(requested.state);
  return checkCompletion(dispatched.state, [...outcome.commands, ...requested.commands, ...dispatched.commands]);
}
