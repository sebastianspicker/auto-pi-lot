import { digest } from "../canonical.js";
import { validateGraph } from "../graph/validate.js";
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

  const nodes: Record<string, NodeRunState> = {};
  for (const node of validated.graph.nodes) nodes[node.id] = freshNodeState();

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
  const node = state.nodes[event.nodeId];
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
      attemptCount: node.attemptCount + 1,
      activeAttemptId: event.attemptId,
      reservedAttemptId: null,
      reservedFencingToken: null,
    },
  };
  const attempts: Record<string, AttemptState> = {
    ...state.attempts,
    [event.attemptId]: { nodeId: event.nodeId, fencingToken: event.fencingToken, status: "dispatched" },
  };
  return accept({ ...state, nodes, attempts });
}

function handleResultProposed(state: RunState, event: ResultProposedEvent): DecideResult {
  const attempt = state.attempts[event.attemptId];
  if (attempt === undefined) return reject(state, "unknown_attempt", `Unknown attempt: ${event.attemptId}`);
  if (attempt.fencingToken !== event.fencingToken) {
    return reject(state, "stale_fencing_token", `Stale fencing token on attempt ${event.attemptId}`);
  }
  if (attempt.status !== "dispatched") {
    return reject(state, "invalid_transition", `Attempt ${event.attemptId} is not awaiting a result`);
  }

  const node = state.nodes[attempt.nodeId] as NodeRunState;
  const nodes = {
    ...state.nodes,
    [attempt.nodeId]: { ...node, execution: "result_ready" as const, disposition: "unverified" as const },
  };
  const attempts = { ...state.attempts, [event.attemptId]: { ...attempt, status: "result_ready" as const } };
  const commands: Command[] = [{ type: "evaluate_acceptance", nodeId: attempt.nodeId, attemptId: event.attemptId }];
  return accept({ ...state, nodes, attempts, permitsInUse: state.permitsInUse - 1 }, commands);
}

function handleAcceptanceDecided(state: RunState, event: AcceptanceDecidedEvent): DecideResult {
  const attempt = state.attempts[event.attemptId];
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

  const node = state.nodes[event.nodeId] as NodeRunState;

  if (event.decision === "accepted") {
    const attempts = { ...state.attempts, [event.attemptId]: { ...attempt, status: "accepted" as const } };
    const nodes = { ...state.nodes, [event.nodeId]: { ...node, disposition: "accepted" as const } };
    return accept({ ...state, nodes, attempts });
  }

  // Rejected while cancelling: the run is winding down, so this attempt's outcome settles
  // the node directly instead of retrying — a retry would need a new permit and dispatch,
  // both forbidden once cancellation has started.
  if (state.status === "cancelling") {
    const attempts = { ...state.attempts, [event.attemptId]: { ...attempt, status: "rejected" as const } };
    const nodes = {
      ...state.nodes,
      [event.nodeId]: { ...node, execution: "cancelled" as const, disposition: "rejected" as const },
    };
    return accept({ ...state, nodes, attempts });
  }

  // Rejected. A dependent that already consumed this node's provisional `result_ready`
  // output keeps its own state: invalidation propagation to dependents is later work
  // (decision 0001 scopes this reducer to one flat graph without cascading invalidation).
  const policy = state.policy as NonNullable<RunState["policy"]>; // guaranteed by decide(): the run has started
  if (node.attemptCount < policy.maxAttemptsPerNode) {
    const attempts = { ...state.attempts, [event.attemptId]: { ...attempt, status: "superseded" as const } };
    const nodes = {
      ...state.nodes,
      [event.nodeId]: { ...node, execution: "pending" as const, disposition: null, activeAttemptId: null },
    };
    return accept({ ...state, nodes, attempts });
  }

  const attempts = { ...state.attempts, [event.attemptId]: { ...attempt, status: "rejected" as const } };
  const nodes = {
    ...state.nodes,
    [event.nodeId]: {
      ...node,
      execution: "exhausted" as const,
      disposition: "rejected" as const,
      failureCategory: "review_rejected" as const,
    },
  };
  return accept({ ...state, nodes, attempts });
}

/** Shared by `attempt_failed` and `lease_expired`: both release a permit and retry-or-exhaust. */
function handleAttemptTerminated(
  state: RunState,
  attemptId: string,
  fencingToken: number,
  category: FailureCategory,
): DecideResult {
  const attempt = state.attempts[attemptId];
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

  if (state.status === "cancelling") {
    const nodes = {
      ...state.nodes,
      [attempt.nodeId]: { ...node, execution: "cancelled" as const, activeAttemptId: null },
    };
    return accept({ ...state, nodes, attempts, permitsInUse });
  }

  const policy = state.policy as NonNullable<RunState["policy"]>; // guaranteed by decide(): the run has started
  if (node.attemptCount < policy.maxAttemptsPerNode) {
    const nodes = {
      ...state.nodes,
      [attempt.nodeId]: { ...node, execution: "pending" as const, activeAttemptId: null, failureCategory: null },
    };
    return accept({ ...state, nodes, attempts, permitsInUse });
  }

  const nodes = {
    ...state.nodes,
    [attempt.nodeId]: { ...node, execution: "exhausted" as const, activeAttemptId: null, failureCategory: category },
  };
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
      attempts = { ...attempts, [node.activeAttemptId]: { ...attempt, status: "stopping" as const } };
      commands.push({ type: "cancel_attempt", attemptId: node.activeAttemptId });
    } else if (node.execution === "ready") {
      // Drop an unconfirmed reservation: no `attempt_dispatched` ever persisted for it.
      nodes = {
        ...nodes,
        [nodeId]: { ...node, execution: "cancelled" as const, reservedAttemptId: null, reservedFencingToken: null },
      };
      permitsInUse -= 1;
    } else if (node.execution === "pending") {
      nodes = { ...nodes, [nodeId]: { ...node, execution: "cancelled" as const } };
    }
  }

  return accept({ ...state, status: "cancelling", nodes, attempts, permitsInUse }, commands);
}

function handleAttemptStopped(state: RunState, event: AttemptStoppedEvent): DecideResult {
  const attempt = state.attempts[event.attemptId];
  if (attempt === undefined) return reject(state, "unknown_attempt", `Unknown attempt: ${event.attemptId}`);
  if (attempt.status !== "stopping")
    return reject(state, "invalid_transition", `Attempt ${event.attemptId} is not stopping`);

  const node = state.nodes[attempt.nodeId] as NodeRunState;
  const attempts = { ...state.attempts, [event.attemptId]: { ...attempt, status: "stopped" as const } };
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
    const attemptNumber = nodeState.attemptCount + 1;
    const attemptId = digest({ runId: state.runId, nodeId: next.id, attempt: attemptNumber });
    lastFencingToken += 1;
    const fencingToken = lastFencingToken;

    nodes = {
      ...nodes,
      [next.id]: {
        ...nodeState,
        execution: "ready" as const,
        reservedAttemptId: attemptId,
        reservedFencingToken: fencingToken,
      },
    };
    permitsInUse += 1;
    commands.push({ type: "dispatch", nodeId: next.id, attemptId, fencingToken });
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

/** A node whose proposed result is still awaiting (or mid-) an `evaluate_acceptance` decision. */
function hasOutstandingAcceptance(state: RunState): boolean {
  return Object.values(state.nodes).some(
    (node) =>
      node.execution === "result_ready" && (node.disposition === "unverified" || node.disposition === "verifying"),
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
  if (state.appliedEventIds[event.eventId] === true) {
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
 * unchanged. On success, marks the event applied, runs the dispatch loop, then checks for
 * run completion, all before returning to the caller.
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
  const dispatched = runDispatchLoop(applied);
  return checkCompletion(dispatched.state, [...outcome.commands, ...dispatched.commands]);
}
