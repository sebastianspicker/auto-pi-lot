import assert from "node:assert/strict";
import test from "node:test";

import {
  type AcceptanceRequest,
  type AcceptanceVerdict,
  canonicalJson,
  type GraphSpec,
  type JournalEvent,
  type RunPolicy,
  replay,
  validateGraph,
  type WorkerAssignment,
  type WorkerOutcome,
  type WorkerPort,
} from "@auto-pi-lot/core";

import {
  type FakeMode,
  GateProtocolError,
  type HostPorts,
  MemoryJournalStore,
  RunHost,
  ScriptedGate,
  ScriptedWorker,
  type ScriptedWorkerOptions,
} from "../src/index.js";

const RUN_ID = "demo-run";
const POLICY: RunPolicy = { maxConcurrent: 3, maxAttemptsPerNode: 2 };

const demoGraph: GraphSpec = {
  schemaVersion: 1,
  id: "demo-graph",
  runId: RUN_ID,
  depth: 0,
  revision: 1,
  nodes: [
    {
      id: "implement",
      role: "implementer",
      objective: "Produce the requested patch",
      acceptanceCriteria: ["Patch meets the task contract"],
      limits: { maxTokens: 8000, maxToolCalls: 40 },
    },
    {
      id: "verify",
      role: "verifier",
      objective: "Collect reproducible verification evidence",
      acceptanceCriteria: ["Required checks pass against the candidate revision"],
      limits: { maxTokens: 4000, maxToolCalls: 20 },
    },
    {
      id: "review",
      role: "reviewer",
      objective: "Review the verified candidate",
      acceptanceCriteria: ["Acceptance criteria and evidence have been reviewed"],
      limits: { maxTokens: 4000, maxToolCalls: 20 },
    },
  ],
  edges: [
    { from: "implement", to: "verify", condition: "result_ready" },
    { from: "verify", to: "review", condition: "accepted" },
  ],
};

/** One id counter per test, shared by every host of the test so resumed hosts never reuse an id. */
function makePorts(
  journal: MemoryJournalStore,
  worker: ScriptedWorker,
  gate: ScriptedGate,
  nextId: () => string,
): HostPorts {
  return { journal, worker, gate, clock: () => new Date("2026-01-01T00:00:00.000Z"), newEventId: nextId };
}

function counter(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `evt-${n}`;
  };
}

/** Lets detached host work run until `condition` holds. */
async function until(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for: ${label}`);
}

function ofType<T extends JournalEvent["type"]>(
  events: readonly JournalEvent[],
  type: T,
): Extract<JournalEvent, { type: T }>[] {
  return events.filter((event): event is Extract<JournalEvent, { type: T }> => event.type === type);
}

function dispatchedFor(events: readonly JournalEvent[], nodeId: string) {
  return ofType(events, "attempt_dispatched").filter((event) => event.nodeId === nodeId);
}

function assertReplayMatches(host: RunHost, events: readonly JournalEvent[]): void {
  const replayed = replay(events);
  assert.deepEqual(replayed.rejections, []);
  assert.equal(canonicalJson(replayed.state), canonicalJson(host.state));
}

function workerOutcomeResult(label: string): WorkerOutcome {
  return { type: "result", proposalDigest: `sha256:${label}` };
}

test("happy path runs the demo graph to success", async () => {
  const store = new MemoryJournalStore();
  const ports = makePorts(store, new ScriptedWorker(), new ScriptedGate(), counter());
  const host = await RunHost.start(ports, demoGraph, POLICY);
  assert.equal(await host.completion, "succeeded");

  const shape = host.events.map((event) => {
    if (event.type === "attempt_dispatched" || event.type === "acceptance_decided") {
      return `${event.type}:${event.nodeId}`;
    }
    return event.type;
  });
  assert.deepEqual(shape, [
    "run_started",
    "attempt_dispatched:implement",
    "result_proposed",
    "attempt_dispatched:verify",
    "result_proposed",
    "acceptance_decided:verify",
    // The reducer dispatches review in the same step that accepts verify; the gate answers for
    // implement asynchronously, so review's dispatch is persisted first.
    "attempt_dispatched:review",
    "acceptance_decided:implement",
    "result_proposed",
    "acceptance_decided:review",
  ]);
  assert.deepEqual(host.rejections, []);
  assert.equal(host.failure, null);
  assertReplayMatches(host, host.events);
  assert.deepEqual(store.appended, host.events);
});

test("a worker starts only after the attempt_dispatched event is appended", async () => {
  const timeline: string[] = [];
  const store = new MemoryJournalStore({
    beforeAppend: (event) => {
      timeline.push(event.type === "attempt_dispatched" ? `append:${event.attemptId}` : `append:${event.type}`);
    },
  });
  class RecordingWorker extends ScriptedWorker {
    override start(assignment: WorkerAssignment, report: (outcome: WorkerOutcome) => void): void {
      timeline.push(`start:${assignment.attemptId}`);
      super.start(assignment, report);
    }
  }
  const worker = new RecordingWorker();
  const host = await RunHost.start(makePorts(store, worker, new ScriptedGate(), counter()), demoGraph, POLICY);
  assert.equal(await host.completion, "succeeded");

  assert.equal(worker.started.length, 3);
  for (const assignment of worker.started) {
    const appended = timeline.indexOf(`append:${assignment.attemptId}`);
    const started = timeline.indexOf(`start:${assignment.attemptId}`);
    assert.ok(appended >= 0 && started > appended, `start of ${assignment.attemptId} must follow its append`);
  }
});

test("a failed append stops the host without starting the worker or advancing state", async () => {
  const store = new MemoryJournalStore({
    beforeAppend: (event) => {
      if (event.type === "attempt_dispatched") throw new Error("disk full");
    },
  });
  const worker = new ScriptedWorker();
  const host = await RunHost.start(makePorts(store, worker, new ScriptedGate(), counter()), demoGraph, POLICY);
  await assert.rejects(host.completion, /disk full/);

  assert.equal(worker.started.length, 0);
  assert.equal(host.failure?.message, "disk full");
  const implement = host.state.nodes.implement;
  assert.equal(implement?.execution, "ready");
  assert.notEqual(implement?.reservedAttemptId, null);
  assert.deepEqual(
    store.appended.map((event) => event.type),
    ["run_started"],
  );
});

test("a retry gets a new fencing token and the old attempt is fenced out", async () => {
  const store = new MemoryJournalStore();
  const worker = new ScriptedWorker({
    mode: "manual",
    script: { implement: [{ type: "failed", category: "worker_crashed" }] },
  });
  const host = await RunHost.start(makePorts(store, worker, new ScriptedGate(), counter()), demoGraph, POLICY);
  await until(() => worker.started.length === 1, "first implement attempt");
  const first = worker.started[0] as WorkerAssignment;
  worker.release(first.attemptId);
  await until(() => worker.started.length === 2, "retry of implement");
  const second = worker.started[1] as WorkerAssignment;

  assert.notEqual(second.attemptId, first.attemptId);
  assert.ok(second.fencingToken > first.fencingToken);

  const before = store.appended.length;
  const late = await host.report(first.attemptId, first.fencingToken, workerOutcomeResult("late"));
  assert.equal(late.applied, false);
  if (!late.applied) {
    assert.equal(late.reason, "rejected");
    if (late.reason === "rejected") {
      assert.ok(["stale_fencing_token", "invalid_transition"].includes(late.rejection.code));
    }
  }
  assert.equal(store.appended.length, before);
  assert.equal(host.rejections.length, 1);

  // Let the rest of the run finish: the second attempt and the later nodes use the default script.
  worker.release(second.attemptId);
  const workerLoop = setInterval(() => {
    for (const assignment of worker.started) worker.release(assignment.attemptId);
  }, 0);
  try {
    assert.equal(await host.completion, "succeeded");
  } finally {
    clearInterval(workerLoop);
  }
  assert.deepEqual(
    dispatchedFor(host.events, "implement").map((event) => event.fencingToken),
    [first.fencingToken, second.fencingToken],
  );
  assertReplayMatches(host, store.appended);
});

test("a rejected implementation is repaired and verified again", async () => {
  const store = new MemoryJournalStore();
  const worker = new ScriptedWorker();
  let rejectedOnce = false;
  const gate = new ScriptedGate({
    verdicts: (request: AcceptanceRequest): AcceptanceVerdict | undefined => {
      if (request.nodeId !== "implement" || rejectedOnce) return undefined;
      rejectedOnce = true;
      return { decision: "rejected", receiptIds: ["receipt:verify-finding"] };
    },
  });
  const host = await RunHost.start(makePorts(store, worker, gate, counter()), demoGraph, POLICY);
  assert.equal(await host.completion, "succeeded");

  const implementRuns = worker.started.filter((assignment) => assignment.nodeId === "implement");
  assert.equal(implementRuns.length, 2);
  const [firstRun, secondRun] = implementRuns as [WorkerAssignment, WorkerAssignment];
  assert.equal(firstRun.repairOf, null);
  assert.deepEqual(secondRun.repairOf, { attemptId: firstRun.attemptId, receiptIds: ["receipt:verify-finding"] });
  assert.equal(worker.started.filter((assignment) => assignment.nodeId === "verify").length, 2);
  assert.equal(host.state.nodes.verify?.invalidatedAttemptCount, 1);
  assertReplayMatches(host, store.appended);
});

test("cancelling stops the running attempt and ends the run cancelled", async () => {
  const store = new MemoryJournalStore();
  const worker = new ScriptedWorker({ mode: "manual" });
  const host = await RunHost.start(makePorts(store, worker, new ScriptedGate(), counter()), demoGraph, POLICY);
  await until(() => worker.started.length === 1, "implement started");
  const running = worker.started[0] as WorkerAssignment;

  const cancelled = await host.cancel("operator");
  assert.equal(cancelled.applied, true);
  assert.equal(await host.completion, "cancelled");
  assert.deepEqual(worker.cancelled, [running.attemptId]);

  const late = await host.report(running.attemptId, running.fencingToken, workerOutcomeResult("late"));
  assert.equal(late.applied, false);
  assertReplayMatches(host, store.appended);
});

test("resume expires an in-flight attempt, retries it and fences out the old worker", async () => {
  const store = new MemoryJournalStore();
  const nextId = counter();
  const oldWorker = new ScriptedWorker({ mode: "manual" });
  await RunHost.start(makePorts(store, oldWorker, new ScriptedGate(), nextId), demoGraph, POLICY);
  await until(() => oldWorker.started.length === 1, "implement started");
  const old = oldWorker.started[0] as WorkerAssignment;

  const newWorker = new ScriptedWorker();
  const resumed = await RunHost.resume(makePorts(store, newWorker, new ScriptedGate(), nextId), RUN_ID);
  assert.equal(await resumed.completion, "succeeded");

  const expired = ofType(store.appended, "lease_expired");
  assert.deepEqual(
    expired.map((event) => event.attemptId),
    [old.attemptId],
  );
  const dispatches = dispatchedFor(store.appended, "implement");
  assert.equal(dispatches.length, 2);
  assert.ok((dispatches[1]?.fencingToken ?? 0) > old.fencingToken);

  const before = store.appended.length;
  const late = await resumed.report(old.attemptId, old.fencingToken, workerOutcomeResult("late"));
  assert.equal(late.applied, false);
  assert.equal(store.appended.length, before);
  assertReplayMatches(resumed, (await store.read(RUN_ID)).events);
});

test("resume asks the gate again for a verdict that was outstanding at the crash", async () => {
  const store = new MemoryJournalStore();
  const nextId = counter();
  const gate = new ScriptedGate({ mode: "manual" });
  await RunHost.start(makePorts(store, new ScriptedWorker(), gate, nextId), demoGraph, POLICY);
  await until(() => gate.requests.length === 1, "verify acceptance requested");
  const verifyRequest = gate.requests[0] as AcceptanceRequest;
  assert.equal(verifyRequest.nodeId, "verify");
  gate.release(verifyRequest.attemptId);
  await until(() => gate.requests.some((request) => request.nodeId === "implement"), "implement acceptance requested");
  const pending = gate.requests.find((request) => request.nodeId === "implement") as AcceptanceRequest;

  const freshGate = new ScriptedGate();
  const resumed = await RunHost.resume(makePorts(store, new ScriptedWorker(), freshGate, nextId), RUN_ID);
  assert.equal(await resumed.completion, "succeeded");

  assert.equal(freshGate.requests.filter((request) => request.attemptId === pending.attemptId).length, 1);
  const decisions = ofType(store.appended, "acceptance_decided").filter(
    (event) => event.attemptId === pending.attemptId,
  );
  assert.equal(decisions.length, 1);
  assertReplayMatches(resumed, (await store.read(RUN_ID)).events);
});

test("resume re-drives a reservation whose dispatch was never persisted", async () => {
  let failing = true;
  const store = new MemoryJournalStore({
    beforeAppend: (event) => {
      if (failing && event.type === "attempt_dispatched") throw new Error("disk full");
    },
  });
  const nextId = counter();
  const first = await RunHost.start(
    makePorts(store, new ScriptedWorker(), new ScriptedGate(), nextId),
    demoGraph,
    POLICY,
  );
  await assert.rejects(first.completion, /disk full/);
  failing = false;

  const worker = new ScriptedWorker();
  const resumed = await RunHost.resume(makePorts(store, worker, new ScriptedGate(), nextId), RUN_ID);
  assert.equal(await resumed.completion, "succeeded");

  assert.equal(dispatchedFor(store.appended, "implement").length, 1);
  assert.equal(worker.started[0]?.nodeId, "implement");
  assert.equal(ofType(store.appended, "lease_expired").length, 0);
  assertReplayMatches(resumed, (await store.read(RUN_ID)).events);
});

test("resuming a terminal run submits nothing", async () => {
  const store = new MemoryJournalStore();
  const nextId = counter();
  const host = await RunHost.start(
    makePorts(store, new ScriptedWorker(), new ScriptedGate(), nextId),
    demoGraph,
    POLICY,
  );
  assert.equal(await host.completion, "succeeded");
  const size = store.appended.length;

  const worker = new ScriptedWorker();
  const resumed = await RunHost.resume(makePorts(store, worker, new ScriptedGate(), nextId), RUN_ID);
  assert.equal(await resumed.completion, "succeeded");
  assert.equal(store.appended.length, size);
  assert.equal(worker.started.length, 0);
  assert.equal(resumed.recovery.tornTail, false);
});

test("start refuses a run id that already has a journal and appends nothing", async () => {
  const store = new MemoryJournalStore();
  const nextId = counter();
  const host = await RunHost.start(
    makePorts(store, new ScriptedWorker(), new ScriptedGate(), nextId),
    demoGraph,
    POLICY,
  );
  assert.equal(await host.completion, "succeeded");
  const size = store.appended.length;

  await assert.rejects(
    RunHost.start(makePorts(store, new ScriptedWorker(), new ScriptedGate(), nextId), demoGraph, POLICY),
    /already has a journal; use RunHost\.resume/,
  );
  assert.equal(store.appended.length, size);
});

test("cancelling with an empty reason is an invalid submission, not a dead run", async () => {
  const store = new MemoryJournalStore();
  const host = await RunHost.start(
    makePorts(store, new ScriptedWorker(), new ScriptedGate(), counter()),
    demoGraph,
    POLICY,
  );
  const result = await host.cancel("");
  assert.equal(result.applied, false);
  assert.equal(result.applied === false ? result.reason : null, "invalid");
  assert.equal(await host.completion, "succeeded");
  assert.equal(host.failure, null);
  assert.equal(host.rejectedCount, 0);
});

test("a malformed worker outcome fails that attempt as schema_invalid and the retry succeeds", async () => {
  const store = new MemoryJournalStore();
  const worker = new ScriptedWorker({ mode: "manual" });
  const host = await RunHost.start(makePorts(store, worker, new ScriptedGate(), counter()), demoGraph, {
    maxConcurrent: 3,
    maxAttemptsPerNode: 2,
  });
  await until(() => worker.started.length === 1, "first implement attempt");
  const first = worker.started[0] as WorkerAssignment;
  const bad = await host.report(first.attemptId, first.fencingToken, {
    type: "result",
    proposalDigest: "",
  } as unknown as WorkerOutcome);
  assert.equal(bad.applied, true);

  await until(() => worker.started.length === 2, "retry of implement");
  const second = worker.started[1] as WorkerAssignment;
  worker.release(second.attemptId);
  await until(() => worker.started.some((assignment) => assignment.nodeId === "verify"), "verify started");
  const verify = worker.started.find((assignment) => assignment.nodeId === "verify") as WorkerAssignment;
  const notAnObject = await host.report(verify.attemptId, verify.fencingToken, "done" as unknown as WorkerOutcome);
  assert.equal(notAnObject.applied, true);

  const workerLoop = setInterval(() => {
    for (const assignment of worker.started) worker.release(assignment.attemptId);
  }, 0);
  try {
    assert.equal(await host.completion, "succeeded");
  } finally {
    clearInterval(workerLoop);
  }
  assert.deepEqual(
    ofType(host.events, "attempt_failed").map((event) => [event.attemptId, event.category]),
    [
      [first.attemptId, "schema_invalid"],
      [verify.attemptId, "schema_invalid"],
    ],
  );
  assert.deepEqual(
    host.protocolViolations.map((violation) => violation.attemptId),
    [first.attemptId, verify.attemptId],
  );
  assert.ok(host.protocolViolations.every((violation) => violation.issues.length > 0));
  assert.equal(host.failure, null);
  assertReplayMatches(host, store.appended);
});

test("a gate verdict that breaks the port contract fails the host with GateProtocolError", async () => {
  const store = new MemoryJournalStore();
  const gate = new ScriptedGate({ verdicts: () => ({ decision: "accepted", receiptIds: [] }) });
  const host = await RunHost.start(makePorts(store, new ScriptedWorker(), gate, counter()), demoGraph, POLICY);
  await assert.rejects(host.completion, GateProtocolError);
  assert.ok(host.failure instanceof GateProtocolError);
  assert.equal(host.failure.name, "GateProtocolError");
});

/** A worker that records starts and ignores cancel; the test reports outcomes by hand. */
class DeafWorker implements WorkerPort {
  readonly started: WorkerAssignment[] = [];
  start(assignment: WorkerAssignment): void {
    this.started.push(assignment);
  }
  cancel(): void {}
}

test("a result that races a stop is answered with attempt_stopped and the run ends cancelled", async () => {
  const store = new MemoryJournalStore();
  const worker = new DeafWorker();
  const ports = { ...makePorts(store, new ScriptedWorker(), new ScriptedGate(), counter()), worker };
  const host = await RunHost.start(ports, demoGraph, POLICY);
  await until(() => worker.started.length === 1, "implement started");
  const running = worker.started[0] as WorkerAssignment;
  assert.equal((await host.cancel("op")).applied, true);

  const late = await host.report(running.attemptId, running.fencingToken, {
    type: "result",
    proposalDigest: "sha256:late",
  });
  assert.equal(late.applied, false);
  assert.equal(await host.completion, "cancelled");
  assert.deepEqual(
    ofType(store.appended, "attempt_stopped").map((event) => event.attemptId),
    [running.attemptId],
  );
  assertReplayMatches(host, store.appended);
});

test("a worker whose start throws fails the attempt as worker_crashed and the retry succeeds", async () => {
  class ThrowingOnce extends ScriptedWorker {
    calls = 0;
    override start(assignment: WorkerAssignment, report: (outcome: WorkerOutcome) => void): void {
      this.calls += 1;
      if (this.calls === 1) throw new Error("spawn failed");
      super.start(assignment, report);
    }
  }
  const store = new MemoryJournalStore();
  const host = await RunHost.start(makePorts(store, new ThrowingOnce(), new ScriptedGate(), counter()), demoGraph, {
    maxConcurrent: 3,
    maxAttemptsPerNode: 2,
  });
  assert.equal(await host.completion, "succeeded");
  assert.equal(host.failure, null);
  assert.deepEqual(
    ofType(host.events, "attempt_failed").map((event) => event.category),
    ["worker_crashed"],
  );
  assert.equal(dispatchedFor(host.events, "implement").length, 2);
  assertReplayMatches(host, store.appended);
});

/** Small deterministic LCG; test-only. */
function lcg(seed: number): () => number {
  let state = (seed * 2654435761 + 1) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function randomGraph(random: () => number, runId: string): GraphSpec {
  const count = 1 + Math.floor(random() * 5);
  const ids = Array.from({ length: count }, (_, i) => `n${i}`);
  const nodes = ids.map((id) => ({
    id,
    role: "implementer" as const,
    objective: `Do ${id}`,
    acceptanceCriteria: ["Done"],
    limits: { maxTokens: 1000, maxToolCalls: 10 },
  }));
  const edges: GraphSpec["edges"] = [];
  // Only forward edges: acyclic by construction.
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      if (random() < 0.35) {
        edges.push({ from: `n${i}`, to: `n${j}`, condition: random() < 0.5 ? "result_ready" : "accepted" });
      }
    }
  }
  // Drop every edge the validator names, until the graph is valid (as the core simulation does).
  let graph: GraphSpec = { schemaVersion: 1, id: `${runId}-graph`, runId, depth: 0, revision: 1, nodes, edges };
  for (let result = validateGraph(graph); !result.ok; result = validateGraph(graph)) {
    const dropped = new Set(result.issues.map((issue) => issue.path[1]));
    graph = { ...graph, edges: graph.edges.filter((_, index) => !dropped.has(index)) };
  }
  return graph;
}

test("random graphs with flaky workers always reach a terminal state that replays", async () => {
  for (let seed = 0; seed < 50; seed += 1) {
    const random = lcg(seed);
    const graph = randomGraph(random, `run-${seed}`);
    const script: ScriptedWorkerOptions["script"] = Object.fromEntries(
      graph.nodes.map((node) => [
        node.id,
        Array.from(
          { length: 3 },
          (): WorkerOutcome =>
            random() < 0.7 ? workerOutcomeResult(`${node.id}`) : { type: "failed", category: "worker_crashed" },
        ),
      ]),
    );
    const store = new MemoryJournalStore();
    const mode: FakeMode = "immediate";
    const ports = makePorts(store, new ScriptedWorker({ script, mode }), new ScriptedGate(), counter());
    const host = await RunHost.start(ports, graph, { maxConcurrent: 2, maxAttemptsPerNode: 2 });
    const status = await host.completion;

    assert.ok(["succeeded", "failed", "cancelled"].includes(status), `seed ${seed}`);
    assert.equal(host.failure, null, `seed ${seed}`);
    assertReplayMatches(host, store.appended);
    const attemptIds = ofType(host.events, "attempt_dispatched").map((event) => event.attemptId);
    assert.equal(new Set(attemptIds).size, attemptIds.length, `seed ${seed}: attempt id reused`);
  }
});

test("a stopped report for an attempt that was never asked to stop fails it as worker_crashed and the retry runs", async () => {
  const store = new MemoryJournalStore();
  const worker = new DeafWorker();
  const ports = { ...makePorts(store, new ScriptedWorker(), new ScriptedGate(), counter()), worker };
  const host = await RunHost.start(ports, demoGraph, POLICY);
  await until(() => worker.started.length === 1, "first implement attempt");
  const first = worker.started[0] as WorkerAssignment;

  // The worker quits on its own: the reducer refuses `attempt_stopped` (the attempt is not
  // stopping) and the host must not leave the attempt holding its permit forever.
  const quit = await host.report(first.attemptId, first.fencingToken, { type: "stopped" });
  assert.equal(quit.applied, true);
  assert.equal(host.state.attempts[first.attemptId]?.status, "failed");
  assert.deepEqual(
    ofType(host.events, "attempt_failed").map((event) => [event.attemptId, event.category]),
    [[first.attemptId, "worker_crashed"]],
  );

  await until(() => worker.started.length === 2, "retry of implement");
  const second = worker.started[1] as WorkerAssignment;
  assert.notEqual(second.attemptId, first.attemptId);
  assert.ok(second.fencingToken > first.fencingToken);

  // A stale stop from the dead first attempt changes nothing and does not fail the retry.
  const stale = await host.report(first.attemptId, first.fencingToken, { type: "stopped" });
  assert.equal(stale.applied, false);
  assert.equal(host.state.attempts[second.attemptId]?.status, "dispatched");

  for (let i = 1; i < 10 && host.state.status === "running"; i += 1) {
    const assignment = worker.started[i];
    if (assignment === undefined) {
      await until(() => worker.started.length > i, `attempt ${i}`);
      i -= 1;
      continue;
    }
    await host.report(assignment.attemptId, assignment.fencingToken, workerOutcomeResult(assignment.nodeId));
  }
  assert.equal(await host.completion, "succeeded");
  assert.equal(host.failure, null);
  assertReplayMatches(host, store.appended);
});

test("onEvent sees every applied event in order, and a throwing callback does not stop the host", async () => {
  const seen: JournalEvent[] = [];
  const ports: HostPorts = {
    ...makePorts(new MemoryJournalStore(), new ScriptedWorker(), new ScriptedGate(), counter()),
    onEvent: (event) => {
      seen.push(event);
      throw new Error("observer failure");
    },
  };
  const host = await RunHost.start(ports, demoGraph, POLICY);
  assert.equal(await host.completion, "succeeded");
  assert.deepEqual(seen, host.events);
});
