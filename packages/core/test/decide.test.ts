import assert from "node:assert/strict";
import test from "node:test";

import {
  type Command,
  type DecideResult,
  decide,
  initialState,
  type JournalEvent,
  parseGraphSpec,
  parseJournalEvent,
  type RunPolicy,
  type RunState,
  replay,
  type ValidatedGraph,
} from "../src/index.js";

let counter = 0;
function eventId(): string {
  counter += 1;
  return `evt-${counter}`;
}

const AT = "2026-01-01T00:00:00.000Z";
const POLICY: RunPolicy = { maxConcurrent: 3, maxAttemptsPerNode: 2 };

function node(id: string) {
  return {
    id,
    role: "implementer" as const,
    objective: `Do ${id}`,
    acceptanceCriteria: ["Done"],
    limits: { maxTokens: 1000, maxToolCalls: 10 },
  };
}

const soloGraph: ValidatedGraph = parseGraphSpec({
  schemaVersion: 1,
  id: "graph-solo",
  runId: "run-solo",
  depth: 0,
  revision: 1,
  nodes: [node("implement")],
  edges: [],
});

const pipelineGraph: ValidatedGraph = parseGraphSpec({
  schemaVersion: 1,
  id: "graph-pipeline",
  runId: "run-pipeline",
  depth: 0,
  revision: 1,
  nodes: [node("implement"), node("verify"), node("review")],
  edges: [
    { from: "implement", to: "verify", condition: "result_ready" },
    { from: "verify", to: "review", condition: "accepted" },
  ],
});

const acceptedEdgeGraph: ValidatedGraph = parseGraphSpec({
  schemaVersion: 1,
  id: "graph-accepted-edge",
  runId: "run-accepted-edge",
  depth: 0,
  revision: 1,
  nodes: [node("producer"), node("consumer")],
  edges: [{ from: "producer", to: "consumer", condition: "accepted" }],
});

const independentGraph: ValidatedGraph = parseGraphSpec({
  schemaVersion: 1,
  id: "graph-independent",
  runId: "run-independent",
  depth: 0,
  revision: 1,
  nodes: [node("a"), node("b")],
  edges: [],
});

function runStarted(runId: string, graph: ValidatedGraph, policy = POLICY): JournalEvent {
  return { type: "run_started", schemaVersion: 1, eventId: eventId(), runId, at: AT, graph, policy };
}
function attemptDispatched(runId: string, nodeId: string, attemptId: string, fencingToken: number): JournalEvent {
  return {
    type: "attempt_dispatched",
    schemaVersion: 1,
    eventId: eventId(),
    runId,
    at: AT,
    nodeId,
    attemptId,
    fencingToken,
  };
}
function resultProposed(runId: string, attemptId: string, fencingToken: number): JournalEvent {
  return {
    type: "result_proposed",
    schemaVersion: 1,
    eventId: eventId(),
    runId,
    at: AT,
    attemptId,
    fencingToken,
    proposalDigest: "sha256:proposal",
  };
}
function acceptanceDecided(
  runId: string,
  nodeId: string,
  attemptId: string,
  decision: "accepted" | "rejected",
  receiptIds: string[] = decision === "accepted" ? ["receipt-1"] : [],
): JournalEvent {
  return {
    type: "acceptance_decided",
    schemaVersion: 1,
    eventId: eventId(),
    runId,
    at: AT,
    nodeId,
    attemptId,
    decision,
    receiptIds,
  };
}
function attemptFailed(runId: string, attemptId: string, fencingToken: number): JournalEvent {
  return {
    type: "attempt_failed",
    schemaVersion: 1,
    eventId: eventId(),
    runId,
    at: AT,
    attemptId,
    fencingToken,
    category: "worker_crashed",
  };
}
function leaseExpired(runId: string, attemptId: string, fencingToken: number): JournalEvent {
  return { type: "lease_expired", schemaVersion: 1, eventId: eventId(), runId, at: AT, attemptId, fencingToken };
}
function cancelRequested(runId: string, reason = "operator requested"): JournalEvent {
  return { type: "cancel_requested", schemaVersion: 1, eventId: eventId(), runId, at: AT, reason };
}
function attemptStopped(runId: string, attemptId: string): JournalEvent {
  return { type: "attempt_stopped", schemaVersion: 1, eventId: eventId(), runId, at: AT, attemptId };
}

function dispatchCommands(commands: readonly Command[]) {
  return commands.filter((c) => c.type === "dispatch");
}

function apply(state: RunState, event: JournalEvent): DecideResult {
  const result = decide(state, event);
  assert.equal(
    result.rejection,
    undefined,
    `unexpected rejection: ${JSON.stringify(result.rejection)} for ${event.type}`,
  );
  return result;
}

test("happy path: implement -> verify (result_ready) -> review (accepted)", () => {
  let state = initialState();
  let result = apply(state, runStarted("run-pipeline", pipelineGraph));
  state = result.state;
  const dispatches = dispatchCommands(result.commands);
  assert.deepEqual(
    dispatches.map((d) => d.nodeId),
    ["implement"],
  );
  const implementAttempt = required(dispatches[0]);

  result = apply(
    state,
    attemptDispatched("run-pipeline", "implement", implementAttempt.attemptId, implementAttempt.fencingToken),
  );
  state = result.state;
  assert.deepEqual(result.commands, []);

  // implement has a verifying node, so its acceptance waits for verify's accepted result.
  result = apply(state, resultProposed("run-pipeline", implementAttempt.attemptId, implementAttempt.fencingToken));
  state = result.state;
  assert.deepEqual(
    result.commands.map((c) => c.type),
    ["dispatch"],
  );
  assert.equal(state.nodes.implement?.disposition, "verifying");
  const verifyAttempt = required(dispatchCommands(result.commands)[0]);
  assert.equal(verifyAttempt.nodeId, "verify");

  result = apply(
    state,
    attemptDispatched("run-pipeline", "verify", verifyAttempt.attemptId, verifyAttempt.fencingToken),
  );
  state = result.state;

  result = apply(state, resultProposed("run-pipeline", verifyAttempt.attemptId, verifyAttempt.fencingToken));
  state = result.state;
  // "review" needs verify's *acceptance*, not just its result, so it must not dispatch yet.
  assert.deepEqual(
    result.commands.map((c) => c.type),
    ["evaluate_acceptance"],
  );

  result = apply(state, acceptanceDecided("run-pipeline", "verify", verifyAttempt.attemptId, "accepted"));
  state = result.state;
  assert.deepEqual(result.commands[0], {
    type: "evaluate_acceptance",
    nodeId: "implement",
    attemptId: implementAttempt.attemptId,
  });
  const reviewAttempt = required(dispatchCommands(result.commands)[0]);
  assert.equal(reviewAttempt.nodeId, "review");

  result = apply(state, acceptanceDecided("run-pipeline", "implement", implementAttempt.attemptId, "accepted"));
  state = result.state;
  assert.deepEqual(result.commands, []);
  assert.equal(state.nodes.implement?.disposition, "accepted");

  result = apply(
    state,
    attemptDispatched("run-pipeline", "review", reviewAttempt.attemptId, reviewAttempt.fencingToken),
  );
  state = result.state;

  result = apply(state, resultProposed("run-pipeline", reviewAttempt.attemptId, reviewAttempt.fencingToken));
  state = result.state;

  result = apply(state, acceptanceDecided("run-pipeline", "review", reviewAttempt.attemptId, "accepted"));
  state = result.state;
  assert.deepEqual(result.commands, [{ type: "complete_run", status: "succeeded" }]);
  assert.equal(state.status, "succeeded");
});

test("duplicate event is rejected and leaves state unchanged", () => {
  const started = runStarted("run-solo", soloGraph);
  const first = apply(initialState(), started);

  const duplicate = decide(first.state, started);
  assert.equal(duplicate.rejection?.code, "duplicate_event");
  assert.equal(duplicate.state, first.state);
  assert.deepEqual(duplicate.commands, []);
});

test("an event for the wrong run is rejected", () => {
  const first = apply(initialState(), runStarted("run-solo", soloGraph));
  const result = decide(first.state, cancelRequested("some-other-run"));
  assert.equal(result.rejection?.code, "wrong_run");
  assert.equal(result.state, first.state);
});

test("run_started rejects a graph belonging to a different run", () => {
  const state = initialState();
  const result = decide(state, runStarted("some-other-run", soloGraph));
  assert.equal(result.rejection?.code, "wrong_run");
  assert.equal(result.state, state);
  assert.deepEqual(result.commands, []);
});

test("a non-run_started event before run_started is rejected", () => {
  const state = initialState();
  const result = decide(state, cancelRequested("run-solo"));
  assert.equal(result.rejection?.code, "not_started");
  assert.equal(result.state, state);
});

test("starting an already-started run is rejected", () => {
  const first = apply(initialState(), runStarted("run-solo", soloGraph));
  const result = decide(first.state, runStarted("run-solo", soloGraph));
  assert.equal(result.rejection?.code, "already_started");
  assert.equal(result.state, first.state);
});

test("an invalid graph is rejected and never starts the run", () => {
  const cyclicGraph = {
    schemaVersion: 1 as const,
    id: "graph-cycle",
    runId: "run-cycle",
    depth: 0 as const,
    revision: 1,
    nodes: [node("a"), node("b")],
    edges: [
      { from: "a", to: "b", condition: "accepted" as const },
      { from: "b", to: "a", condition: "accepted" as const },
    ],
  };
  const state = initialState();
  const result = decide(state, {
    type: "run_started",
    schemaVersion: 1,
    eventId: eventId(),
    runId: "run-cycle",
    at: AT,
    graph: cyclicGraph,
    policy: POLICY,
  });
  assert.equal(result.rejection?.code, "invalid_graph");
  assert.equal(result.state, state);
});

test("node IDs that name object prototype properties remain ordinary nodes", () => {
  const prototypeGraph = parseGraphSpec({
    schemaVersion: 1,
    id: "graph-prototype-ids",
    runId: "run-prototype-ids",
    depth: 0,
    revision: 1,
    nodes: [node("__proto__"), node("constructor"), node("toString")],
    edges: [],
  });

  const result = decide(
    initialState(),
    runStarted("run-prototype-ids", prototypeGraph, { maxConcurrent: 3, maxAttemptsPerNode: 1 }),
  );

  assert.equal(result.rejection, undefined);
  assert.deepEqual(
    dispatchCommands(result.commands).map((command) => command.nodeId),
    ["__proto__", "constructor", "toString"],
  );
  for (const nodeId of ["__proto__", "constructor", "toString"]) {
    assert.ok(Object.hasOwn(result.state.nodes, nodeId));
    assert.equal(result.state.nodes[nodeId]?.execution, "ready");
  }
});

test("prototype property names do not masquerade as known attempt IDs", () => {
  const started = apply(initialState(), runStarted("run-solo", soloGraph));
  const result = decide(started.state, resultProposed("run-solo", "toString", 1));
  assert.equal(result.rejection?.code, "unknown_attempt");
  assert.equal(result.state, started.state);
});

test("a mismatched fencing token is rejected without mutating state", () => {
  let result = apply(initialState(), runStarted("run-solo", soloGraph));
  const attempt = required(dispatchCommands(result.commands)[0]);
  result = apply(result.state, attemptDispatched("run-solo", "implement", attempt.attemptId, attempt.fencingToken));

  const stale = decide(result.state, resultProposed("run-solo", attempt.attemptId, attempt.fencingToken + 100));
  assert.equal(stale.rejection?.code, "stale_fencing_token");
  assert.equal(stale.state, result.state);
});

test("a late message for an attempt that already terminated is rejected", () => {
  let result = apply(initialState(), runStarted("run-solo", soloGraph, { maxConcurrent: 1, maxAttemptsPerNode: 2 }));
  const firstAttempt = required(dispatchCommands(result.commands)[0]);
  result = apply(
    result.state,
    attemptDispatched("run-solo", "implement", firstAttempt.attemptId, firstAttempt.fencingToken),
  );
  result = apply(result.state, leaseExpired("run-solo", firstAttempt.attemptId, firstAttempt.fencingToken));

  // The node retried under a brand new attempt ID; the original attempt ID's own (correct)
  // token now belongs to a terminated attempt, so a late result for it is `invalid_transition`
  // rather than `stale_fencing_token` (attempt IDs are never reused across retries).
  const late = decide(result.state, resultProposed("run-solo", firstAttempt.attemptId, firstAttempt.fencingToken));
  assert.equal(late.rejection?.code, "invalid_transition");
  assert.equal(late.state, result.state);
});

test("retry after failure gets a new attempt id and fencing token, then exhausts", () => {
  let result = apply(initialState(), runStarted("run-solo", soloGraph, { maxConcurrent: 1, maxAttemptsPerNode: 2 }));
  const firstAttempt = required(dispatchCommands(result.commands)[0]);
  result = apply(
    result.state,
    attemptDispatched("run-solo", "implement", firstAttempt.attemptId, firstAttempt.fencingToken),
  );

  result = apply(result.state, attemptFailed("run-solo", firstAttempt.attemptId, firstAttempt.fencingToken));
  const retryDispatch = required(dispatchCommands(result.commands)[0]);
  assert.notEqual(retryDispatch.attemptId, firstAttempt.attemptId);
  assert.ok(retryDispatch.fencingToken > firstAttempt.fencingToken);
  assert.equal(result.state.nodes.implement?.attemptCount, 1);

  result = apply(
    result.state,
    attemptDispatched("run-solo", "implement", retryDispatch.attemptId, retryDispatch.fencingToken),
  );
  result = apply(result.state, attemptFailed("run-solo", retryDispatch.attemptId, retryDispatch.fencingToken));

  assert.equal(result.state.nodes.implement?.execution, "exhausted");
  assert.equal(result.state.nodes.implement?.failureCategory, "worker_crashed");
  assert.equal(result.state.status, "failed");
  assert.deepEqual(result.commands, [{ type: "complete_run", status: "failed" }]);
});

test("acceptance rejection retries with a new attempt id", () => {
  let result = apply(initialState(), runStarted("run-solo", soloGraph, { maxConcurrent: 1, maxAttemptsPerNode: 2 }));
  const firstAttempt = required(dispatchCommands(result.commands)[0]);
  result = apply(
    result.state,
    attemptDispatched("run-solo", "implement", firstAttempt.attemptId, firstAttempt.fencingToken),
  );
  result = apply(result.state, resultProposed("run-solo", firstAttempt.attemptId, firstAttempt.fencingToken));

  result = apply(result.state, acceptanceDecided("run-solo", "implement", firstAttempt.attemptId, "rejected"));
  const retryDispatch = required(dispatchCommands(result.commands)[0]);
  assert.notEqual(retryDispatch.attemptId, firstAttempt.attemptId);
  assert.equal(result.state.nodes.implement?.execution, "ready");
  assert.equal(result.state.attempts[firstAttempt.attemptId]?.status, "superseded");
});

test("acceptance is idempotent per attempt (repro A): a second decision for an attempt already accepted is rejected", () => {
  // producer --accepted--> consumer: accept producer, consumer dispatches on the strength of
  // that acceptance, then a second (conflicting) decision for producer's same attempt arrives.
  let result = apply(
    initialState(),
    runStarted("run-accepted-edge", acceptedEdgeGraph, { maxConcurrent: 2, maxAttemptsPerNode: 2 }),
  );
  const producerAttempt = required(dispatchCommands(result.commands)[0]);
  assert.equal(producerAttempt.nodeId, "producer");

  result = apply(
    result.state,
    attemptDispatched("run-accepted-edge", "producer", producerAttempt.attemptId, producerAttempt.fencingToken),
  );
  result = apply(
    result.state,
    resultProposed("run-accepted-edge", producerAttempt.attemptId, producerAttempt.fencingToken),
  );

  result = apply(
    result.state,
    acceptanceDecided("run-accepted-edge", "producer", producerAttempt.attemptId, "accepted"),
  );
  const consumerAttempt = required(dispatchCommands(result.commands)[0]);
  assert.equal(consumerAttempt.nodeId, "consumer");
  assert.equal(result.state.nodes.producer?.disposition, "accepted");
  assert.equal(result.state.attempts[producerAttempt.attemptId]?.status, "accepted");

  result = apply(
    result.state,
    attemptDispatched("run-accepted-edge", "consumer", consumerAttempt.attemptId, consumerAttempt.fencingToken),
  );

  // A same-eventId-free, later "rejected" decision for producer's already-decided attempt
  // must not re-apply and re-reserve producer while consumer is running on its acceptance.
  const beforeStale = result.state;
  const stale = decide(
    result.state,
    acceptanceDecided("run-accepted-edge", "producer", producerAttempt.attemptId, "rejected"),
  );
  assert.equal(stale.rejection?.code, "invalid_transition");
  assert.equal(stale.state, beforeStale);
  assert.equal(stale.state.nodes.producer?.disposition, "accepted");
  assert.equal(stale.state.nodes.consumer?.execution, "running");
});

test("acceptance is idempotent per attempt (repro B): a second decision for an exhausted-rejected attempt is rejected and the run still fails", () => {
  // a, b independent, maxAttemptsPerNode 1: reject a to exhaustion, then a conflicting
  // "accepted" decision for the same attempt arrives; it must not flip a back to accepted,
  // and the run must still fail once b settles (never "succeeded").
  let result = apply(
    initialState(),
    runStarted("run-independent", independentGraph, { maxConcurrent: 2, maxAttemptsPerNode: 1 }),
  );
  const dispatches = dispatchCommands(result.commands);
  const aAttempt = required(dispatches.find((d) => d.nodeId === "a"));
  const bAttempt = required(dispatches.find((d) => d.nodeId === "b"));

  result = apply(result.state, attemptDispatched("run-independent", "a", aAttempt.attemptId, aAttempt.fencingToken));
  result = apply(result.state, attemptDispatched("run-independent", "b", bAttempt.attemptId, bAttempt.fencingToken));
  result = apply(result.state, resultProposed("run-independent", aAttempt.attemptId, aAttempt.fencingToken));

  result = apply(result.state, acceptanceDecided("run-independent", "a", aAttempt.attemptId, "rejected"));
  assert.equal(result.state.nodes.a?.execution, "exhausted");
  assert.equal(result.state.nodes.a?.disposition, "rejected");
  assert.equal(result.state.attempts[aAttempt.attemptId]?.status, "rejected");

  const beforeStale = result.state;
  const stale = decide(result.state, acceptanceDecided("run-independent", "a", aAttempt.attemptId, "accepted"));
  assert.equal(stale.rejection?.code, "invalid_transition");
  assert.equal(stale.state, beforeStale);
  assert.equal(stale.state.nodes.a?.execution, "exhausted");
  assert.equal(stale.state.nodes.a?.disposition, "rejected");

  result = apply(result.state, resultProposed("run-independent", bAttempt.attemptId, bAttempt.fencingToken));
  result = apply(result.state, acceptanceDecided("run-independent", "b", bAttempt.attemptId, "accepted"));

  assert.equal(result.state.status, "failed");
  assert.deepEqual(result.commands, [{ type: "complete_run", status: "failed" }]);
});

test("cancel mid-run stops dispatch and waits for attempt_stopped before completing", () => {
  let result = apply(initialState(), runStarted("run-solo", soloGraph));
  const attempt = required(dispatchCommands(result.commands)[0]);
  result = apply(result.state, attemptDispatched("run-solo", "implement", attempt.attemptId, attempt.fencingToken));

  result = apply(result.state, cancelRequested("run-solo"));
  assert.equal(result.state.status, "cancelling");
  assert.deepEqual(result.commands, [{ type: "cancel_attempt", attemptId: attempt.attemptId }]);
  assert.equal(result.state.permitsInUse, 1);

  // Nothing new dispatches while cancelling, and results for a stopping attempt are rejected.
  const rejectedResult = decide(result.state, resultProposed("run-solo", attempt.attemptId, attempt.fencingToken));
  assert.equal(rejectedResult.rejection?.code, "invalid_transition");

  result = apply(result.state, attemptStopped("run-solo", attempt.attemptId));
  assert.equal(result.state.status, "cancelled");
  assert.equal(result.state.permitsInUse, 0);
  assert.deepEqual(result.commands, [{ type: "complete_run", status: "cancelled" }]);
});

test("cancel with an outstanding acceptance evaluation stays cancelling until a rejection settles it as cancelled", () => {
  let result = apply(initialState(), runStarted("run-solo", soloGraph));
  const attempt = required(dispatchCommands(result.commands)[0]);
  result = apply(result.state, attemptDispatched("run-solo", "implement", attempt.attemptId, attempt.fencingToken));
  result = apply(result.state, resultProposed("run-solo", attempt.attemptId, attempt.fencingToken));
  assert.equal(result.state.permitsInUse, 0);

  result = apply(result.state, cancelRequested("run-solo"));
  assert.equal(result.state.status, "cancelling");
  assert.deepEqual(result.commands, []);
  assert.equal(dispatchCommands(result.commands).length, 0);

  result = apply(result.state, acceptanceDecided("run-solo", "implement", attempt.attemptId, "rejected"));
  assert.equal(result.state.nodes.implement?.execution, "cancelled");
  assert.equal(result.state.nodes.implement?.disposition, "rejected");
  assert.equal(result.state.status, "cancelled");
  assert.deepEqual(result.commands, [{ type: "complete_run", status: "cancelled" }]);
});

test("cancel with an outstanding acceptance evaluation records an accepted decision before becoming cancelled", () => {
  let result = apply(initialState(), runStarted("run-solo", soloGraph));
  const attempt = required(dispatchCommands(result.commands)[0]);
  result = apply(result.state, attemptDispatched("run-solo", "implement", attempt.attemptId, attempt.fencingToken));
  result = apply(result.state, resultProposed("run-solo", attempt.attemptId, attempt.fencingToken));

  result = apply(result.state, cancelRequested("run-solo"));
  assert.equal(result.state.status, "cancelling");
  assert.equal(dispatchCommands(result.commands).length, 0);

  result = apply(result.state, acceptanceDecided("run-solo", "implement", attempt.attemptId, "accepted"));
  assert.equal(result.state.nodes.implement?.disposition, "accepted");
  assert.equal(result.state.status, "cancelled");
  assert.deepEqual(result.commands, [{ type: "complete_run", status: "cancelled" }]);
  assert.equal(dispatchCommands(result.commands).length, 0);
});

test("events after a terminal run are rejected", () => {
  let result = apply(initialState(), runStarted("run-solo", soloGraph));
  const attempt = required(dispatchCommands(result.commands)[0]);
  result = apply(result.state, attemptDispatched("run-solo", "implement", attempt.attemptId, attempt.fencingToken));
  result = apply(result.state, resultProposed("run-solo", attempt.attemptId, attempt.fencingToken));
  result = apply(result.state, acceptanceDecided("run-solo", "implement", attempt.attemptId, "accepted"));
  assert.equal(result.state.status, "succeeded");

  const after = decide(result.state, cancelRequested("run-solo"));
  assert.equal(after.rejection?.code, "run_terminal");
  assert.equal(after.state, result.state);
});

test("decide never throws for malformed events cast past the JournalEvent type", () => {
  const garbageInputs: unknown[] = [
    {},
    { type: "run_started" },
    { type: "attempt_dispatched", eventId: "x" },
    { type: "not_a_real_event", eventId: "y", runId: "run-solo" },
    null,
    42,
    "a string",
    [1, 2, 3],
  ];
  const state = initialState();
  for (const garbage of garbageInputs) {
    assert.doesNotThrow(() => decide(state, garbage as JournalEvent));
    // Malformed input never validates at the contract boundary, so a real host never
    // constructs a `JournalEvent` from it in the first place.
    const parsed = parseJournalEvent(garbage);
    assert.equal(parsed.ok, false);
  }
});

test("replay of an accepted event log reproduces the same final state as live decide calls", () => {
  const events: JournalEvent[] = [];
  let state = initialState();
  let lastResult: DecideResult = { state, commands: [] };

  const record = (event: JournalEvent) => {
    events.push(event);
    lastResult = decide(state, event);
    assert.equal(lastResult.rejection, undefined);
    state = lastResult.state;
    return lastResult;
  };

  record(runStarted("run-solo", soloGraph));
  const firstAttempt = required(dispatchCommands(lastResult.commands)[0]);

  record(attemptDispatched("run-solo", "implement", firstAttempt.attemptId, firstAttempt.fencingToken));
  record(resultProposed("run-solo", firstAttempt.attemptId, firstAttempt.fencingToken));
  record(acceptanceDecided("run-solo", "implement", firstAttempt.attemptId, "accepted"));

  assert.equal(state.status, "succeeded");
  const replayed = replay(events);
  assert.deepEqual(replayed.rejections, []);
  assert.deepEqual(replayed.state, state);
});

test("an accepted decision without receipts is rejected as missing_evidence", () => {
  let result = apply(initialState(), runStarted("run-solo", soloGraph));
  const dispatch = required(dispatchCommands(result.commands)[0]);
  result = apply(result.state, attemptDispatched("run-solo", "implement", dispatch.attemptId, dispatch.fencingToken));
  result = apply(result.state, resultProposed("run-solo", dispatch.attemptId, dispatch.fencingToken));

  const event = acceptanceDecided("run-solo", "implement", dispatch.attemptId, "accepted", []);
  const rejected = decide(result.state, event);
  assert.equal(rejected.rejection?.code, "missing_evidence");
  assert.equal(rejected.state, result.state);
  assert.deepEqual(rejected.commands, []);

  const parsed = parseJournalEvent(event);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.deepEqual(parsed.issues[0]?.path, ["receiptIds"]);
});

const dependencyGraph: ValidatedGraph = parseGraphSpec({
  schemaVersion: 1,
  id: "graph-dependency",
  runId: "run-dependency",
  depth: 0,
  revision: 1,
  nodes: [node("a"), node("b"), node("c"), node("d")],
  edges: [
    { from: "a", to: "b", condition: "accepted" },
    { from: "b", to: "c", condition: "result_ready" },
  ],
});
const DEP_POLICY = { maxConcurrent: 2, maxAttemptsPerNode: 1 };

function startDependencyRun() {
  const events: JournalEvent[] = [];
  let state = initialState();
  let last: DecideResult = { state, commands: [] };
  const record = (event: JournalEvent) => {
    events.push(event);
    last = apply(state, event);
    state = last.state;
    return last;
  };
  record(runStarted("run-dependency", dependencyGraph, DEP_POLICY));
  const dispatches = dispatchCommands(last.commands);
  assert.deepEqual(dispatches.map((d) => d.nodeId).sort(), ["a", "d"]);
  for (const d of dispatches) {
    record(attemptDispatched("run-dependency", d.nodeId, d.attemptId, d.fencingToken));
  }
  const byNode = (id: string) => required(dispatches.find((d) => d.nodeId === id));
  return { events, record, byNode, getState: () => state, getLast: () => last };
}

function assertReplays(events: JournalEvent[], state: RunState) {
  const replayed = replay(events);
  assert.deepEqual(replayed.rejections, []);
  assert.deepEqual(replayed.state, state);
}

test("an exhausted node fails its pending dependents transitively; unrelated work drains", () => {
  const { events, record, byNode, getState } = startDependencyRun();
  const a = byNode("a");
  const d = byNode("d");

  const failed = record(attemptFailed("run-dependency", a.attemptId, a.fencingToken));
  const s = getState();
  assert.equal(s.nodes.a?.execution, "exhausted");
  assert.equal(s.nodes.a?.failureCategory, "worker_crashed");
  for (const id of ["b", "c"]) {
    assert.equal(s.nodes[id]?.execution, "failed");
    assert.equal(s.nodes[id]?.failureCategory, "dependency_failed");
  }
  assert.equal(s.nodes.d?.execution, "running");
  assert.equal(s.status, "running");
  assert.deepEqual(dispatchCommands(failed.commands), []);

  record(resultProposed("run-dependency", d.attemptId, d.fencingToken));
  const done = record(acceptanceDecided("run-dependency", "d", d.attemptId, "accepted"));
  assert.equal(getState().status, "failed");
  assert.deepEqual(done.commands, [{ type: "complete_run", status: "failed" }]);
  assertReplays(events, getState());
});

test("a rejection that exhausts a node fails its pending dependents", () => {
  const { events, record, byNode, getState } = startDependencyRun();
  const a = byNode("a");
  const d = byNode("d");

  record(resultProposed("run-dependency", a.attemptId, a.fencingToken));
  const rejected = record(acceptanceDecided("run-dependency", "a", a.attemptId, "rejected"));
  const s = getState();
  assert.equal(s.nodes.a?.execution, "exhausted");
  assert.equal(s.nodes.a?.failureCategory, "review_rejected");
  for (const id of ["b", "c"]) {
    assert.equal(s.nodes[id]?.execution, "failed");
    assert.equal(s.nodes[id]?.failureCategory, "dependency_failed");
  }
  assert.equal(s.nodes.d?.execution, "running");
  assert.equal(s.status, "running");
  assert.deepEqual(dispatchCommands(rejected.commands), []);

  record(resultProposed("run-dependency", d.attemptId, d.fencingToken));
  const done = record(acceptanceDecided("run-dependency", "d", d.attemptId, "accepted"));
  assert.equal(getState().status, "failed");
  assert.deepEqual(done.commands, [{ type: "complete_run", status: "failed" }]);
  assertReplays(events, getState());
});

test("a dependent that already started is not failed when its producer is exhausted", () => {
  const graph: ValidatedGraph = parseGraphSpec({
    schemaVersion: 1,
    id: "graph-started-dependent",
    runId: "run-started-dependent",
    depth: 0,
    revision: 1,
    nodes: [node("p"), node("q")],
    edges: [{ from: "p", to: "q", condition: "result_ready" }],
  });
  const runId = "run-started-dependent";
  const events: JournalEvent[] = [];
  let state = initialState();
  let last: DecideResult = { state, commands: [] };
  const record = (event: JournalEvent) => {
    events.push(event);
    last = apply(state, event);
    state = last.state;
    return last;
  };

  record(runStarted(runId, graph, { maxConcurrent: 2, maxAttemptsPerNode: 1 }));
  const p = required(dispatchCommands(last.commands)[0]);
  record(attemptDispatched(runId, "p", p.attemptId, p.fencingToken));
  record(resultProposed(runId, p.attemptId, p.fencingToken));
  const q = required(dispatchCommands(last.commands)[0]);
  assert.equal(q.nodeId, "q");
  record(attemptDispatched(runId, "q", q.attemptId, q.fencingToken));
  record(acceptanceDecided(runId, "p", p.attemptId, "rejected"));

  assert.equal(state.nodes.p?.execution, "exhausted");
  assert.equal(state.nodes.q?.execution, "running");
  assert.equal(state.nodes.q?.failureCategory, null);
  assertReplays(events, state);
});

test("a retried dependent fails with dependency_failed when its producer has meanwhile been exhausted", () => {
  const graph: ValidatedGraph = parseGraphSpec({
    schemaVersion: 1,
    id: "graph-retried-dependent",
    runId: "run-retried-dependent",
    depth: 0,
    revision: 1,
    nodes: [node("p"), node("q")],
    edges: [{ from: "p", to: "q", condition: "result_ready" }],
  });
  const runId = "run-retried-dependent";
  const events: JournalEvent[] = [];
  let state = initialState();
  let last: DecideResult = { state, commands: [] };
  const record = (event: JournalEvent) => {
    events.push(event);
    last = apply(state, event);
    state = last.state;
    return last;
  };

  record(runStarted(runId, graph, { maxConcurrent: 2, maxAttemptsPerNode: 2 }));
  const p1 = required(dispatchCommands(last.commands)[0]);
  record(attemptDispatched(runId, "p", p1.attemptId, p1.fencingToken));
  record(attemptFailed(runId, p1.attemptId, p1.fencingToken));
  const p2 = required(dispatchCommands(last.commands)[0]);
  assert.equal(p2.nodeId, "p");
  record(attemptDispatched(runId, "p", p2.attemptId, p2.fencingToken));
  record(resultProposed(runId, p2.attemptId, p2.fencingToken));
  const q1 = required(dispatchCommands(last.commands)[0]);
  assert.equal(q1.nodeId, "q");
  record(attemptDispatched(runId, "q", q1.attemptId, q1.fencingToken));

  // p's second and last attempt is rejected while q is still running on its provisional result.
  record(acceptanceDecided(runId, "p", p2.attemptId, "rejected"));
  assert.equal(state.nodes.p?.execution, "exhausted");
  assert.equal(state.nodes.q?.execution, "running");

  // q's own attempt fails with attempts left, but it can never become ready again: its producer
  // is gone. Instead of returning to `pending` it fails as a dependency failure and the run ends.
  const done = record(attemptFailed(runId, q1.attemptId, q1.fencingToken));
  assert.equal(state.nodes.q?.execution, "failed");
  assert.equal(state.nodes.q?.failureCategory, "dependency_failed");
  assert.equal(state.nodes.q?.attemptCount, 1);
  assert.deepEqual(dispatchCommands(done.commands), []);
  assert.equal(state.status, "failed");
  assert.deepEqual(done.commands, [{ type: "complete_run", status: "failed" }]);
  assertReplays(events, state);
});

// ---------------------------------------------------------------------------------------
// Decision 0005: deferred producer acceptance, candidate binding and invalidation.
// ---------------------------------------------------------------------------------------

function graphOf(runId: string, nodeIds: string[], edges: ValidatedGraph["edges"]): ValidatedGraph {
  return parseGraphSpec({
    schemaVersion: 1,
    id: `graph-${runId}`,
    runId,
    depth: 0,
    revision: 1,
    nodes: nodeIds.map(node),
    edges,
  });
}

/** P -> V (result_ready): V verifies P. */
const verifiedGraph = graphOf("run-verified", ["p", "v"], [{ from: "p", to: "v", condition: "result_ready" }]);

function startRun(runId: string, graph: ValidatedGraph, policy = POLICY) {
  const events: JournalEvent[] = [];
  let state = initialState();
  let last: DecideResult = { state, commands: [] };
  const record = (event: JournalEvent) => {
    events.push(event);
    last = apply(state, event);
    state = last.state;
    return last;
  };
  record(runStarted(runId, graph, policy));
  return { events, record, getState: () => state, getLast: () => last };
}

function onlyDispatch(commands: readonly Command[], nodeId: string) {
  const dispatch = dispatchCommands(commands).find((d) => d.nodeId === nodeId);
  assert.ok(dispatch !== undefined, `no dispatch for ${nodeId} in ${JSON.stringify(commands)}`);
  return dispatch;
}

function assertConsumes(
  dispatch: { readonly consumes: Readonly<Record<string, string>> },
  expected: Record<string, string>,
) {
  assert.deepEqual(dispatch.consumes, expected);
}

/** Starts `run-verified`, dispatches and proposes p, then dispatches v on it. */
function startVerifiedRun(policy = POLICY) {
  const run = startRun("run-verified", verifiedGraph, policy);
  const p = onlyDispatch(run.getLast().commands, "p");
  run.record(attemptDispatched("run-verified", "p", p.attemptId, p.fencingToken));
  run.record(resultProposed("run-verified", p.attemptId, p.fencingToken));
  const v = onlyDispatch(run.getLast().commands, "v");
  return { ...run, p, v };
}

for (const phase of ["reserved", "proposed", "accepted", "stopped", "failed", "expired"] as const) {
  test(`cancellation: rejection invalidates accepted and ${phase} consumers transitively`, () => {
    const runId = `run-cancel-invalidation-${phase}`;
    const graph = graphOf(
      runId,
      ["p", "c", "d", "unrelated"],
      [
        { from: "p", to: "c", condition: "result_ready" },
        { from: "c", to: "d", condition: "accepted" },
      ],
    );
    const { events, record, getState, getLast } = startRun(runId, graph);
    const p = onlyDispatch(getLast().commands, "p");
    const unrelated = onlyDispatch(getLast().commands, "unrelated");
    record(attemptDispatched(runId, "unrelated", unrelated.attemptId, unrelated.fencingToken));
    record(resultProposed(runId, unrelated.attemptId, unrelated.fencingToken));
    record(attemptDispatched(runId, "p", p.attemptId, p.fencingToken));
    record(resultProposed(runId, p.attemptId, p.fencingToken));
    const c = onlyDispatch(getLast().commands, "c");
    record(attemptDispatched(runId, "c", c.attemptId, c.fencingToken));
    record(resultProposed(runId, c.attemptId, c.fencingToken));
    record(acceptanceDecided(runId, "c", c.attemptId, "accepted"));
    const d = onlyDispatch(getLast().commands, "d");
    if (phase !== "reserved") {
      record(attemptDispatched(runId, "d", d.attemptId, d.fencingToken));
    }
    if (phase === "proposed" || phase === "accepted") {
      record(resultProposed(runId, d.attemptId, d.fencingToken));
    }
    if (phase === "accepted") record(acceptanceDecided(runId, "d", d.attemptId, "accepted"));

    const stopping = phase === "stopped" || phase === "failed" || phase === "expired";
    const cancel = record(cancelRequested(runId));
    assert.deepEqual(cancel.commands, stopping ? [{ type: "cancel_attempt", attemptId: d.attemptId }] : []);
    const unrelatedBefore = getState().nodes.unrelated;
    const rejection = acceptanceDecided(runId, "p", p.attemptId, "rejected", ["failed-check"]);
    const rejected = record(rejection);
    assert.deepEqual(rejected.commands, []); // No retries, duplicate stops or premature completion.
    assert.equal(getState().nodes.c?.execution, "cancelled");
    assert.equal(getState().nodes.c?.disposition, "invalidated");
    assert.equal(getState().nodes.c?.activeAttemptId, null);
    assert.equal(getState().nodes.c?.acceptanceRequested, false);
    assert.equal(getState().attempts[c.attemptId]?.status, "invalidated");
    assert.equal(getState().attempts[c.attemptId]?.invalidated, true);
    assert.deepEqual(getState().nodes.unrelated, unrelatedBefore);
    assert.equal(getState().permitsInUse, stopping ? 1 : 0);
    assert.equal(decide(getState(), rejection).rejection?.code, "duplicate_event");

    if (phase === "reserved") {
      assert.equal(getState().nodes.d?.execution, "cancelled");
      assert.equal(getState().nodes.d?.reservedAttemptId, null);
      assert.equal(getState().attempts[d.attemptId], undefined);
    } else if (stopping) {
      assert.equal(getState().attempts[d.attemptId]?.invalidated, true);
      assert.equal(getState().attempts[d.attemptId]?.status, "stopping");
      assert.equal(
        decide(getState(), resultProposed(runId, d.attemptId, d.fencingToken)).rejection?.code,
        "stale_candidate",
      );
      const end =
        phase === "stopped"
          ? attemptStopped(runId, d.attemptId)
          : phase === "failed"
            ? attemptFailed(runId, d.attemptId, d.fencingToken)
            : leaseExpired(runId, d.attemptId, d.fencingToken);
      assert.deepEqual(record(end).commands, []);
      assert.equal(getState().nodes.d?.execution, "cancelled");
    } else {
      assert.equal(getState().nodes.d?.execution, "cancelled");
      assert.equal(getState().nodes.d?.disposition, "invalidated");
      assert.equal(getState().nodes.d?.acceptanceRequested, false);
      assert.equal(getState().attempts[d.attemptId]?.status, "invalidated");
      const late = decide(getState(), acceptanceDecided(runId, "d", d.attemptId, "accepted"));
      assert.equal(late.rejection?.code, "invalid_transition");
      assert.deepEqual(late.state, getState());
    }

    const done = record(acceptanceDecided(runId, "unrelated", unrelated.attemptId, "accepted"));
    assert.deepEqual(done.commands, [{ type: "complete_run", status: "cancelled" }]);
    assert.equal(done.state.permitsInUse, 0);
    assert.equal(done.state.nodes.unrelated?.disposition, "accepted");
    const replayed = replay(events);
    assert.deepEqual(replayed.rejections, []);
    assert.deepEqual(replayed.state, done.state);
  });
}

test("decision 0005: a verified producer's acceptance waits for its verifying node, and a rejection repairs it", () => {
  const runId = "run-pipeline";
  const { events, record, getState, getLast } = startRun(runId, pipelineGraph);
  const i1 = onlyDispatch(getLast().commands, "implement");
  assertConsumes(i1, {});
  assert.equal(i1.repairOf, null);
  record(attemptDispatched(runId, "implement", i1.attemptId, i1.fencingToken));

  record(resultProposed(runId, i1.attemptId, i1.fencingToken));
  assert.equal(getState().nodes.implement?.disposition, "verifying");
  assert.equal(getState().nodes.implement?.acceptanceRequested, false);
  assert.ok(getLast().commands.every((c) => c.type !== "evaluate_acceptance"));
  const v1 = onlyDispatch(getLast().commands, "verify");
  assertConsumes(v1, { implement: i1.attemptId });

  const early = decide(getState(), acceptanceDecided(runId, "implement", i1.attemptId, "accepted"));
  assert.equal(early.rejection?.code, "verification_incomplete");
  assert.equal(early.state, getState());
  assert.deepEqual(early.commands, []);

  record(attemptDispatched(runId, "verify", v1.attemptId, v1.fencingToken));
  assert.deepEqual(getState().attempts[v1.attemptId]?.consumes, { implement: i1.attemptId });

  // Fail fast: the host rejects implement on a failing receipt before verify finished.
  const rejected = record(acceptanceDecided(runId, "implement", i1.attemptId, "rejected", ["check-failed-1"]));
  assert.ok(rejected.commands.some((c) => c.type === "cancel_attempt" && c.attemptId === v1.attemptId));
  assert.equal(getState().attempts[v1.attemptId]?.status, "stopping");
  assert.equal(getState().attempts[v1.attemptId]?.invalidated, true);
  assert.equal(getState().nodes.verify?.execution, "running");
  const i2 = onlyDispatch(rejected.commands, "implement");
  assert.deepEqual(i2.repairOf, { attemptId: i1.attemptId, receiptIds: ["check-failed-1"] });
  record(attemptDispatched(runId, "implement", i2.attemptId, i2.fencingToken));

  record(attemptStopped(runId, v1.attemptId));
  assert.equal(getState().nodes.verify?.execution, "pending");
  assert.equal(getState().nodes.verify?.attemptCount, 1);
  assert.equal(getState().nodes.verify?.invalidatedAttemptCount, 1);
  assert.equal(getState().attempts[v1.attemptId]?.status, "stopped");

  record(resultProposed(runId, i2.attemptId, i2.fencingToken));
  const v2 = onlyDispatch(getLast().commands, "verify");
  assert.notEqual(v2.attemptId, v1.attemptId);
  assertConsumes(v2, { implement: i2.attemptId });
  record(attemptDispatched(runId, "verify", v2.attemptId, v2.fencingToken));
  record(resultProposed(runId, v2.attemptId, v2.fencingToken));
  const verifyAccepted = record(acceptanceDecided(runId, "verify", v2.attemptId, "accepted"));
  assert.deepEqual(
    verifyAccepted.commands.filter((c) => c.type === "evaluate_acceptance"),
    [{ type: "evaluate_acceptance", nodeId: "implement", attemptId: i2.attemptId }],
  );
  const r1 = onlyDispatch(verifyAccepted.commands, "review");
  assertConsumes(r1, { verify: v2.attemptId });

  record(acceptanceDecided(runId, "implement", i2.attemptId, "accepted"));
  record(attemptDispatched(runId, "review", r1.attemptId, r1.fencingToken));
  record(resultProposed(runId, r1.attemptId, r1.fencingToken));
  const done = record(acceptanceDecided(runId, "review", r1.attemptId, "accepted"));
  assert.deepEqual(done.commands, [{ type: "complete_run", status: "succeeded" }]);
  assertReplays(events, getState());
});

test("decision 0005: rejecting a producer invalidates a verifying node's proposed result", () => {
  const runId = "run-pipeline";
  const { events, record, getState, getLast } = startRun(runId, pipelineGraph);
  const i1 = onlyDispatch(getLast().commands, "implement");
  record(attemptDispatched(runId, "implement", i1.attemptId, i1.fencingToken));
  record(resultProposed(runId, i1.attemptId, i1.fencingToken));
  const v1 = onlyDispatch(getLast().commands, "verify");
  record(attemptDispatched(runId, "verify", v1.attemptId, v1.fencingToken));
  record(resultProposed(runId, v1.attemptId, v1.fencingToken));
  assert.deepEqual(getLast().commands, [{ type: "evaluate_acceptance", nodeId: "verify", attemptId: v1.attemptId }]);

  record(acceptanceDecided(runId, "implement", i1.attemptId, "rejected", ["check-failed-1"]));
  const s = getState();
  assert.equal(s.attempts[v1.attemptId]?.status, "invalidated");
  assert.equal(s.attempts[v1.attemptId]?.invalidated, true);
  assert.equal(s.nodes.verify?.execution, "pending");
  assert.equal(s.nodes.verify?.disposition, "invalidated");
  assert.equal(s.nodes.verify?.invalidatedAttemptCount, 1);
  assert.equal(s.nodes.verify?.acceptanceRequested, false);

  const late = decide(s, acceptanceDecided(runId, "verify", v1.attemptId, "accepted"));
  assert.equal(late.rejection?.code, "invalid_transition");
  assert.equal(late.state, s);
  assert.equal(s.status, "running");
  assert.equal(s.nodes.implement?.execution, "ready");
  assertReplays(events, s);
});

test("decision 0005: invalidation cascades through an accepted consumer of an invalidated result", () => {
  const runId = "run-transitive";
  const graph = graphOf(
    runId,
    ["p", "c", "d"],
    [
      { from: "p", to: "c", condition: "result_ready" },
      { from: "c", to: "d", condition: "accepted" },
    ],
  );
  const { events, record, getState, getLast } = startRun(runId, graph);
  const p1 = onlyDispatch(getLast().commands, "p");
  record(attemptDispatched(runId, "p", p1.attemptId, p1.fencingToken));
  record(resultProposed(runId, p1.attemptId, p1.fencingToken));
  const c1 = onlyDispatch(getLast().commands, "c");
  record(attemptDispatched(runId, "c", c1.attemptId, c1.fencingToken));
  record(resultProposed(runId, c1.attemptId, c1.fencingToken));
  const cAccepted = record(acceptanceDecided(runId, "c", c1.attemptId, "accepted"));
  assert.ok(cAccepted.commands.some((c) => c.type === "evaluate_acceptance" && c.nodeId === "p"));
  const d1 = onlyDispatch(cAccepted.commands, "d");
  assertConsumes(d1, { c: c1.attemptId });
  record(attemptDispatched(runId, "d", d1.attemptId, d1.fencingToken));

  const rejected = record(acceptanceDecided(runId, "p", p1.attemptId, "rejected", ["check-failed-1"]));
  let s = getState();
  assert.equal(s.nodes.c?.execution, "pending");
  assert.equal(s.nodes.c?.disposition, "invalidated");
  assert.equal(s.attempts[c1.attemptId]?.status, "invalidated");
  assert.equal(s.attempts[d1.attemptId]?.status, "stopping");
  assert.equal(s.attempts[d1.attemptId]?.invalidated, true);
  assert.ok(rejected.commands.some((c) => c.type === "cancel_attempt" && c.attemptId === d1.attemptId));

  record(attemptStopped(runId, d1.attemptId));
  s = getState();
  assert.equal(s.nodes.d?.execution, "pending");
  for (const id of ["c", "d"]) {
    const n = required(s.nodes[id]);
    assert.equal(n.attemptCount - n.invalidatedAttemptCount, 0, `${id} spent its retry allowance`);
  }

  const p2 = onlyDispatch(rejected.commands, "p");
  record(attemptDispatched(runId, "p", p2.attemptId, p2.fencingToken));
  record(resultProposed(runId, p2.attemptId, p2.fencingToken));
  const c2 = onlyDispatch(getLast().commands, "c");
  assertConsumes(c2, { p: p2.attemptId });
  record(attemptDispatched(runId, "c", c2.attemptId, c2.fencingToken));
  record(resultProposed(runId, c2.attemptId, c2.fencingToken));
  const d2 = onlyDispatch(record(acceptanceDecided(runId, "c", c2.attemptId, "accepted")).commands, "d");
  record(acceptanceDecided(runId, "p", p2.attemptId, "accepted"));
  record(attemptDispatched(runId, "d", d2.attemptId, d2.fencingToken));
  record(resultProposed(runId, d2.attemptId, d2.fencingToken));
  record(acceptanceDecided(runId, "d", d2.attemptId, "accepted"));
  assert.equal(getState().status, "succeeded");
  assertReplays(events, getState());
});

test("decision 0005: rejecting a producer drops a verifying node's unconfirmed reservation", () => {
  const { events, record, getState, p, v } = startVerifiedRun({ maxConcurrent: 2, maxAttemptsPerNode: 2 });
  assert.equal(getState().nodes.v?.execution, "ready");
  assert.equal(getState().permitsInUse, 1);

  const rejected = record(acceptanceDecided("run-verified", "p", p.attemptId, "rejected"));
  const s = getState();
  assert.equal(s.nodes.v?.execution, "pending");
  assert.equal(s.nodes.v?.reservedAttemptId, null);
  assert.equal(s.nodes.v?.reservedConsumes, null);
  assert.equal(s.nodes.v?.attemptCount, 0);
  // Only p's retry reservation holds a permit now.
  assert.deepEqual(
    dispatchCommands(rejected.commands).map((d) => d.nodeId),
    ["p"],
  );
  assert.equal(s.permitsInUse, 1);

  const late = decide(s, attemptDispatched("run-verified", "v", v.attemptId, v.fencingToken));
  assert.equal(late.rejection?.code, "invalid_transition");
  assert.equal(late.state, s);
  assertReplays(events, s);
});

test("decision 0005: a result from an invalidated attempt is rejected as stale_candidate", () => {
  const { events, record, getState, p, v } = startVerifiedRun();
  record(attemptDispatched("run-verified", "v", v.attemptId, v.fencingToken));
  record(acceptanceDecided("run-verified", "p", p.attemptId, "rejected"));

  const s = getState();
  const stale = decide(s, resultProposed("run-verified", v.attemptId, v.fencingToken));
  assert.equal(stale.rejection?.code, "stale_candidate");
  assert.equal(stale.state, s);
  assert.deepEqual(stale.commands, []);
  assertReplays(events, s);
});

test("decision 0005: an exhausted verifying node makes its producer unacceptable and fails its dependents", () => {
  const runId = "run-exhausted-verifier";
  const graph = graphOf(
    runId,
    ["p", "v", "d"],
    [
      { from: "p", to: "v", condition: "result_ready" },
      { from: "p", to: "d", condition: "accepted" },
    ],
  );
  const { events, record, getState, getLast } = startRun(runId, graph, { maxConcurrent: 2, maxAttemptsPerNode: 1 });
  const p = onlyDispatch(getLast().commands, "p");
  record(attemptDispatched(runId, "p", p.attemptId, p.fencingToken));
  record(resultProposed(runId, p.attemptId, p.fencingToken));
  const v = onlyDispatch(getLast().commands, "v");
  record(attemptDispatched(runId, "v", v.attemptId, v.fencingToken));

  const done = record(attemptFailed(runId, v.attemptId, v.fencingToken));
  const s = getState();
  assert.equal(s.nodes.v?.execution, "exhausted");
  assert.equal(s.nodes.d?.execution, "failed");
  assert.equal(s.nodes.d?.failureCategory, "dependency_failed");
  assert.equal(s.nodes.p?.execution, "result_ready");
  assert.equal(s.nodes.p?.disposition, "verifying");
  assert.equal(s.status, "failed");
  assert.deepEqual(done.commands, [{ type: "complete_run", status: "failed" }]);
  assertReplays(events, s);
});

test("decision 0005: cancelling a run with a verifying producer does not wait for its decision", () => {
  const { events, record, getState, v } = startVerifiedRun();
  record(attemptDispatched("run-verified", "v", v.attemptId, v.fencingToken));

  const cancel = record(cancelRequested("run-verified"));
  assert.deepEqual(cancel.commands, [{ type: "cancel_attempt", attemptId: v.attemptId }]);
  const done = record(attemptStopped("run-verified", v.attemptId));
  const s = getState();
  assert.equal(s.nodes.v?.execution, "cancelled");
  assert.equal(s.nodes.p?.disposition, "verifying");
  assert.equal(s.status, "cancelled");
  assert.deepEqual(done.commands, [{ type: "complete_run", status: "cancelled" }]);
  assertReplays(events, s);
});

test("decision 0005: cancellation during an invalidation stops the attempt once and settles it as cancelled", () => {
  const { events, record, getState, p, v } = startVerifiedRun();
  record(attemptDispatched("run-verified", "v", v.attemptId, v.fencingToken));
  const rejected = record(acceptanceDecided("run-verified", "p", p.attemptId, "rejected"));
  assert.ok(rejected.commands.some((c) => c.type === "cancel_attempt" && c.attemptId === v.attemptId));

  const cancel = record(cancelRequested("run-verified"));
  assert.ok(cancel.commands.every((c) => c.type !== "cancel_attempt"));
  assert.equal(getState().status, "cancelling");

  const done = record(attemptStopped("run-verified", v.attemptId));
  const s = getState();
  assert.equal(s.nodes.v?.execution, "cancelled");
  assert.equal(s.nodes.v?.invalidatedAttemptCount, 0);
  assert.equal(s.status, "cancelled");
  assert.deepEqual(done.commands, [{ type: "complete_run", status: "cancelled" }]);
  assertReplays(events, s);
});

test("decision 0005: missing_evidence is checked before verification_incomplete", () => {
  const { getState, p } = startVerifiedRun();
  const result = decide(getState(), acceptanceDecided("run-verified", "p", p.attemptId, "accepted", []));
  assert.equal(result.rejection?.code, "missing_evidence");
  assert.equal(result.state, getState());
});

test("decision 0007: a dropped reservation's next reservation gets a new attempt id", () => {
  const { events, record, getState, getLast, p, v } = startVerifiedRun({ maxConcurrent: 2, maxAttemptsPerNode: 2 });
  assert.equal(getState().nodes.v?.execution, "ready");

  const rejected = record(acceptanceDecided("run-verified", "p", p.attemptId, "rejected"));
  assert.equal(getState().nodes.v?.attemptCount, 0);
  const p2 = onlyDispatch(rejected.commands, "p");
  record(attemptDispatched("run-verified", "p", p2.attemptId, p2.fencingToken));
  record(resultProposed("run-verified", p2.attemptId, p2.fencingToken));
  const v2 = onlyDispatch(getLast().commands, "v");

  assert.notEqual(v2.attemptId, v.attemptId);
  assert.notEqual(v2.fencingToken, v.fencingToken);
  assertConsumes(v2, { p: p2.attemptId });
  assertReplays(events, getState());
});

test("decision 0007: an accepted attempt clears repairOf for a later dispatch after invalidation", () => {
  const { events, record, getState, getLast, p, v } = startVerifiedRun();
  record(attemptDispatched("run-verified", "v", v.attemptId, v.fencingToken));
  record(resultProposed("run-verified", v.attemptId, v.fencingToken));
  const vRejected = record(acceptanceDecided("run-verified", "v", v.attemptId, "rejected", ["review-1"]));
  const v2 = onlyDispatch(vRejected.commands, "v");
  assert.deepEqual(v2.repairOf, { attemptId: v.attemptId, receiptIds: ["review-1"] });

  record(attemptDispatched("run-verified", "v", v2.attemptId, v2.fencingToken));
  record(resultProposed("run-verified", v2.attemptId, v2.fencingToken));
  const vAccepted = record(acceptanceDecided("run-verified", "v", v2.attemptId, "accepted"));
  assert.ok(vAccepted.commands.some((c) => c.type === "evaluate_acceptance" && c.nodeId === "p"));
  assert.equal(getState().nodes.v?.lastRejection, null);

  const pRejected = record(acceptanceDecided("run-verified", "p", p.attemptId, "rejected", ["check-failed-1"]));
  assert.equal(getState().nodes.v?.disposition, "invalidated");
  const p2 = onlyDispatch(pRejected.commands, "p");
  record(attemptDispatched("run-verified", "p", p2.attemptId, p2.fencingToken));
  record(resultProposed("run-verified", p2.attemptId, p2.fencingToken));
  const v3 = onlyDispatch(getLast().commands, "v");
  assert.equal(v3.repairOf, null);
  assertConsumes(v3, { p: p2.attemptId });
  assertReplays(events, getState());
});

test("decision 0007: a failed invalidated attempt returns its node to pending without spending a retry", () => {
  const { events, record, getState, getLast, p, v } = startVerifiedRun();
  record(attemptDispatched("run-verified", "v", v.attemptId, v.fencingToken));
  const rejected = record(acceptanceDecided("run-verified", "p", p.attemptId, "rejected"));
  assert.equal(getState().attempts[v.attemptId]?.status, "stopping");
  const p2 = onlyDispatch(rejected.commands, "p");
  record(attemptDispatched("run-verified", "p", p2.attemptId, p2.fencingToken));
  assert.equal(getState().permitsInUse, 2);

  record(attemptFailed("run-verified", v.attemptId, v.fencingToken));
  let s = getState();
  assert.equal(s.nodes.v?.execution, "pending");
  assert.equal(s.nodes.v?.attemptCount, 1);
  assert.equal(s.nodes.v?.invalidatedAttemptCount, 1);
  assert.equal(s.attempts[v.attemptId]?.status, "failed");
  assert.equal(s.permitsInUse, 1);

  // v's own attempt fails once more. With two attempts per node it is retried rather than
  // exhausted: the invalidated attempt did not count against its allowance.
  record(resultProposed("run-verified", p2.attemptId, p2.fencingToken));
  const v2 = onlyDispatch(getLast().commands, "v");
  record(attemptDispatched("run-verified", "v", v2.attemptId, v2.fencingToken));
  const failed = record(attemptFailed("run-verified", v2.attemptId, v2.fencingToken));
  s = getState();
  assert.equal(s.nodes.v?.attemptCount, 2);
  const v3 = onlyDispatch(failed.commands, "v");
  assertConsumes(v3, { p: p2.attemptId });
  assertReplays(events, s);
});

test("decision 0007: an expired invalidated attempt fails its node when its producer is meanwhile exhausted", () => {
  const { events, record, getState, p, v } = startVerifiedRun();
  record(attemptDispatched("run-verified", "v", v.attemptId, v.fencingToken));
  const rejected = record(acceptanceDecided("run-verified", "p", p.attemptId, "rejected"));
  const p2 = onlyDispatch(rejected.commands, "p");
  record(attemptDispatched("run-verified", "p", p2.attemptId, p2.fencingToken));
  record(attemptFailed("run-verified", p2.attemptId, p2.fencingToken));
  assert.equal(getState().nodes.p?.execution, "exhausted");
  assert.equal(getState().nodes.v?.execution, "running");

  const done = record(leaseExpired("run-verified", v.attemptId, v.fencingToken));
  const s = getState();
  assert.equal(s.nodes.v?.execution, "failed");
  assert.equal(s.nodes.v?.failureCategory, "dependency_failed");
  assert.equal(s.attempts[v.attemptId]?.status, "failed");
  assert.equal(s.permitsInUse, 0);
  assert.equal(s.status, "failed");
  assert.deepEqual(done.commands, [{ type: "complete_run", status: "failed" }]);
  assertReplays(events, s);
});

test("decision 0007: an acceptance request withdrawn by an invalidated verifying node is emitted again", () => {
  const runId = "run-withdrawn";
  const graph = graphOf(
    runId,
    ["p", "q", "v1", "v2"],
    [
      { from: "p", to: "v1", condition: "result_ready" },
      { from: "p", to: "v2", condition: "result_ready" },
      { from: "q", to: "v2", condition: "result_ready" },
    ],
  );
  const { events, record, getState, getLast } = startRun(runId, graph, { maxConcurrent: 4, maxAttemptsPerNode: 2 });
  const p = onlyDispatch(getLast().commands, "p");
  const q1 = onlyDispatch(getLast().commands, "q");
  record(attemptDispatched(runId, "p", p.attemptId, p.fencingToken));
  record(attemptDispatched(runId, "q", q1.attemptId, q1.fencingToken));
  record(resultProposed(runId, p.attemptId, p.fencingToken));
  const v1 = onlyDispatch(getLast().commands, "v1");
  record(resultProposed(runId, q1.attemptId, q1.fencingToken));
  const v2 = onlyDispatch(getLast().commands, "v2");
  assertConsumes(v2, { p: p.attemptId, q: q1.attemptId });
  for (const attempt of [v1, v2]) {
    record(attemptDispatched(runId, attempt.nodeId, attempt.attemptId, attempt.fencingToken));
    record(resultProposed(runId, attempt.attemptId, attempt.fencingToken));
  }
  record(acceptanceDecided(runId, "v1", v1.attemptId, "accepted"));
  const v2Accepted = record(acceptanceDecided(runId, "v2", v2.attemptId, "accepted"));
  assert.deepEqual(
    v2Accepted.commands.filter((c) => c.type === "evaluate_acceptance" && c.nodeId === "p"),
    [{ type: "evaluate_acceptance", nodeId: "p", attemptId: p.attemptId }],
  );
  assert.equal(getState().nodes.p?.acceptanceRequested, true);

  const qRejected = record(acceptanceDecided(runId, "q", q1.attemptId, "rejected"));
  assert.equal(getState().nodes.v2?.disposition, "invalidated");
  assert.equal(getState().nodes.p?.acceptanceRequested, false);
  const early = decide(getState(), acceptanceDecided(runId, "p", p.attemptId, "accepted"));
  assert.equal(early.rejection?.code, "verification_incomplete");
  assert.equal(early.state, getState());

  const q2 = onlyDispatch(qRejected.commands, "q");
  record(attemptDispatched(runId, "q", q2.attemptId, q2.fencingToken));
  record(resultProposed(runId, q2.attemptId, q2.fencingToken));
  const v2Again = onlyDispatch(getLast().commands, "v2");
  assertConsumes(v2Again, { p: p.attemptId, q: q2.attemptId });
  record(attemptDispatched(runId, "v2", v2Again.attemptId, v2Again.fencingToken));
  record(resultProposed(runId, v2Again.attemptId, v2Again.fencingToken));
  const reAccepted = record(acceptanceDecided(runId, "v2", v2Again.attemptId, "accepted"));
  assert.deepEqual(
    reAccepted.commands.filter((c) => c.type === "evaluate_acceptance" && c.nodeId === "p"),
    [{ type: "evaluate_acceptance", nodeId: "p", attemptId: p.attemptId }],
  );
  assert.equal(getState().nodes.p?.acceptanceRequested, true);
  assertReplays(events, getState());
});

test("decision 0007: evaluability of a deep verifier lattice is computed in one pass", () => {
  const runId = "run-lattice";
  const layers = 12;
  const width = 3;
  const layer = (k: number) => Array.from({ length: width }, (_, i) => `n${k}-${i}`);
  const nodeIds = Array.from({ length: layers }, (_, k) => layer(k)).flat();
  const edges: ValidatedGraph["edges"] = [];
  for (let k = 0; k + 1 < layers; k += 1) {
    for (const from of layer(k)) {
      for (const to of layer(k + 1)) edges.push({ from, to, condition: "result_ready" });
    }
  }
  // `top` needs the acceptance of a lattice root; `bottom` the acceptance of a bottom node that
  // does not exhaust.
  edges.push({ from: "n0-0", to: "top", condition: "accepted" });
  edges.push({ from: `n${layers - 1}-1`, to: "bottom", condition: "accepted" });
  const graph = graphOf(runId, [...nodeIds, "top", "bottom"], edges);
  const { events, record, getState, getLast } = startRun(runId, graph, {
    maxConcurrent: width,
    maxAttemptsPerNode: 1,
  });

  for (let k = 0; k < layers; k += 1) {
    const dispatches = dispatchCommands(getLast().commands);
    assert.deepEqual(
      dispatches.map((d) => d.nodeId),
      layer(k),
    );
    for (const d of dispatches) record(attemptDispatched(runId, d.nodeId, d.attemptId, d.fencingToken));
    if (k + 1 === layers) break;
    for (const d of dispatches) record(resultProposed(runId, d.attemptId, d.fencingToken));
  }
  assert.equal(getState().nodes["n0-0"]?.disposition, "verifying");

  const bottom = required(getState().nodes[`n${layers - 1}-0`]);
  const attemptId = required(bottom.activeAttemptId);
  const fencingToken = required(getState().attempts[attemptId]).fencingToken;
  const event = attemptFailed(runId, attemptId, fencingToken);
  events.push(event);
  const started = performance.now();
  const result = apply(getState(), event);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 500, `decide took ${elapsed} ms`);

  const s = result.state;
  assert.equal(s.nodes[`n${layers - 1}-0`]?.execution, "exhausted");
  assert.equal(s.nodes.top?.execution, "failed");
  assert.equal(s.nodes.top?.failureCategory, "dependency_failed");
  assert.equal(s.nodes.bottom?.execution, "pending");
  assert.equal(s.nodes[`n${layers - 1}-1`]?.execution, "running");
  assert.equal(s.status, "running");
  assertReplays(events, s);
});

test("a node id of __proto__ is bound like any other producer, so its verifier completes verification", () => {
  // `consumes[producerId] = ...` on a plain object would hit the prototype setter for this id and
  // silently drop the binding; the reducer must create an own key instead.
  const graph = graphOf(
    "run-proto",
    ["__proto__", "check"],
    [{ from: "__proto__", to: "check", condition: "result_ready" }],
  );
  const run = startRun("run-proto", graph);
  const producer = onlyDispatch(run.getLast().commands, "__proto__");
  run.record(attemptDispatched("run-proto", "__proto__", producer.attemptId, producer.fencingToken));
  run.record(resultProposed("run-proto", producer.attemptId, producer.fencingToken));
  const check = onlyDispatch(run.getLast().commands, "check");
  assert.ok(Object.hasOwn(check.consumes, "__proto__"), "the binding must be an own key");
  assert.equal(Object.entries(check.consumes).find(([key]) => key === "__proto__")?.[1], producer.attemptId);

  run.record(attemptDispatched("run-proto", "check", check.attemptId, check.fencingToken));
  run.record(resultProposed("run-proto", check.attemptId, check.fencingToken));
  const accepted = run.record(acceptanceDecided("run-proto", "check", check.attemptId, "accepted", ["receipt-check"]));
  assert.equal(accepted.rejection, undefined);
  assert.ok(
    accepted.commands.some((command) => command.type === "evaluate_acceptance" && command.nodeId === "__proto__"),
    "the producer's acceptance must be requested once its verifier accepted",
  );
  const done = run.record(acceptanceDecided("run-proto", "__proto__", producer.attemptId, "accepted", ["receipt-p"]));
  assert.equal(done.rejection, undefined);
  assert.equal(done.state.status, "succeeded");
  assertReplays(run.events, done.state);
});

// ---------------------------------------------------------------------------------------
// Writer slots (decision 0011)
// ---------------------------------------------------------------------------------------

function roleNode(id: string, role: "implementer" | "explorer" | "reviewer") {
  return { ...node(id), role };
}

const mixedGraph: ValidatedGraph = parseGraphSpec({
  schemaVersion: 1,
  id: "graph-mixed",
  runId: "run-mixed",
  depth: 0,
  revision: 1,
  nodes: [roleNode("w1", "implementer"), roleNode("w2", "implementer"), roleNode("r1", "explorer")],
  edges: [],
});

function dispatchedNodeIds(commands: readonly Command[]): string[] {
  return commands.filter((command) => command.type === "dispatch").map((command) => command.nodeId);
}

test("writer slots: with one slot, a second ready writer waits while readers still dispatch", () => {
  const started = decide(
    initialState(),
    runStarted("run-mixed", mixedGraph, { maxConcurrent: 3, maxAttemptsPerNode: 1, maxConcurrentWriters: 1 }),
  );
  assert.equal(started.rejection, undefined);
  assert.deepEqual(dispatchedNodeIds(started.commands), ["w1", "r1"]);
  assert.equal(started.state.permitsInUse, 2);
  assert.equal(started.state.nodes.w2?.execution, "pending");
});

test("writer slots: the slot is released when the writer's result is proposed, then the next writer starts", () => {
  let state = decide(
    initialState(),
    runStarted("run-mixed", mixedGraph, { maxConcurrent: 3, maxAttemptsPerNode: 1, maxConcurrentWriters: 1 }),
  ).state;
  const w1 = state.nodes.w1;
  assert.ok(w1?.reservedAttemptId && w1.reservedFencingToken);
  state = apply(state, {
    type: "attempt_dispatched",
    schemaVersion: 1,
    eventId: eventId(),
    runId: "run-mixed",
    at: AT,
    nodeId: "w1",
    attemptId: w1.reservedAttemptId,
    fencingToken: w1.reservedFencingToken,
  }).state;
  const proposed = decide(state, {
    type: "result_proposed",
    schemaVersion: 1,
    eventId: eventId(),
    runId: "run-mixed",
    at: AT,
    attemptId: w1.reservedAttemptId,
    fencingToken: w1.reservedFencingToken,
    proposalDigest: "sha256:w1",
  });
  assert.equal(proposed.rejection, undefined);
  assert.deepEqual(dispatchedNodeIds(proposed.commands), ["w2"]);
});

test("writer slots: omitted maxConcurrentWriters bounds writers by maxConcurrent only", () => {
  const started = decide(
    initialState(),
    runStarted("run-mixed", mixedGraph, { maxConcurrent: 3, maxAttemptsPerNode: 1 }),
  );
  assert.deepEqual(dispatchedNodeIds(started.commands), ["w1", "w2", "r1"]);
});

test("writer slots: a run_started policy with maxConcurrentWriters survives replay unchanged", () => {
  const policy = { maxConcurrent: 2, maxAttemptsPerNode: 1, maxConcurrentWriters: 1 };
  const events = [runStarted("run-mixed", mixedGraph, policy)];
  const replayed = replay(events);
  assert.deepEqual(replayed.rejections, []);
  assert.deepEqual(replayed.state.policy, policy);
});

function required<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null, "Required test fixture is missing");
  return value;
}
