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
const POLICY = { maxConcurrent: 3, maxAttemptsPerNode: 2 };

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
    receiptIds: [],
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
  const implementAttempt = dispatches[0]!;

  result = apply(
    state,
    attemptDispatched("run-pipeline", "implement", implementAttempt.attemptId, implementAttempt.fencingToken),
  );
  state = result.state;
  assert.deepEqual(result.commands, []);

  result = apply(state, resultProposed("run-pipeline", implementAttempt.attemptId, implementAttempt.fencingToken));
  state = result.state;
  assert.deepEqual(
    result.commands.map((c) => c.type),
    ["evaluate_acceptance", "dispatch"],
  );
  const verifyAttempt = dispatchCommands(result.commands)[0]!;
  assert.equal(verifyAttempt.nodeId, "verify");

  result = apply(state, acceptanceDecided("run-pipeline", "implement", implementAttempt.attemptId, "accepted"));
  state = result.state;
  assert.deepEqual(result.commands, []);
  assert.equal(state.nodes.implement?.disposition, "accepted");

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
  const reviewAttempt = dispatchCommands(result.commands)[0]!;
  assert.equal(reviewAttempt.nodeId, "review");

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

test("a mismatched fencing token is rejected without mutating state", () => {
  let result = apply(initialState(), runStarted("run-solo", soloGraph));
  const attempt = dispatchCommands(result.commands)[0]!;
  result = apply(result.state, attemptDispatched("run-solo", "implement", attempt.attemptId, attempt.fencingToken));

  const stale = decide(result.state, resultProposed("run-solo", attempt.attemptId, attempt.fencingToken + 100));
  assert.equal(stale.rejection?.code, "stale_fencing_token");
  assert.equal(stale.state, result.state);
});

test("a late message for an attempt that already terminated is rejected", () => {
  let result = apply(initialState(), runStarted("run-solo", soloGraph, { maxConcurrent: 1, maxAttemptsPerNode: 2 }));
  const firstAttempt = dispatchCommands(result.commands)[0]!;
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
  const firstAttempt = dispatchCommands(result.commands)[0]!;
  result = apply(
    result.state,
    attemptDispatched("run-solo", "implement", firstAttempt.attemptId, firstAttempt.fencingToken),
  );

  result = apply(result.state, attemptFailed("run-solo", firstAttempt.attemptId, firstAttempt.fencingToken));
  const retryDispatch = dispatchCommands(result.commands)[0]!;
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
  const firstAttempt = dispatchCommands(result.commands)[0]!;
  result = apply(
    result.state,
    attemptDispatched("run-solo", "implement", firstAttempt.attemptId, firstAttempt.fencingToken),
  );
  result = apply(result.state, resultProposed("run-solo", firstAttempt.attemptId, firstAttempt.fencingToken));

  result = apply(result.state, acceptanceDecided("run-solo", "implement", firstAttempt.attemptId, "rejected"));
  const retryDispatch = dispatchCommands(result.commands)[0]!;
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
  const producerAttempt = dispatchCommands(result.commands)[0]!;
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
  const consumerAttempt = dispatchCommands(result.commands)[0]!;
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
  const aAttempt = dispatches.find((d) => d.nodeId === "a")!;
  const bAttempt = dispatches.find((d) => d.nodeId === "b")!;

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
  const attempt = dispatchCommands(result.commands)[0]!;
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
  const attempt = dispatchCommands(result.commands)[0]!;
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
  const attempt = dispatchCommands(result.commands)[0]!;
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
  const attempt = dispatchCommands(result.commands)[0]!;
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
  const firstAttempt = dispatchCommands(lastResult.commands)[0]!;

  record(attemptDispatched("run-solo", "implement", firstAttempt.attemptId, firstAttempt.fencingToken));
  record(resultProposed("run-solo", firstAttempt.attemptId, firstAttempt.fencingToken));
  record(acceptanceDecided("run-solo", "implement", firstAttempt.attemptId, "accepted"));

  assert.equal(state.status, "succeeded");
  const replayed = replay(events);
  assert.deepEqual(replayed.rejections, []);
  assert.deepEqual(replayed.state, state);
});
