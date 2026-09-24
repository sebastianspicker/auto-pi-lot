import assert from "node:assert/strict";

import {
  type Command,
  decide,
  type FailureCategory,
  type GraphSpec,
  initialState,
  isDependencySatisfied,
  isTerminalStatus,
  type JournalEvent,
  type ResultDisposition,
  type RunState,
  replay,
} from "../../src/index.js";
import { Prng } from "./prng.js";

export interface SimOptions {
  readonly maxSteps?: number;
}

export interface SimResult {
  readonly seed: number;
  readonly steps: number;
  readonly finalState: RunState;
  readonly journal: readonly JournalEvent[];
}

function randomGraph(rng: Prng, runId: string): GraphSpec {
  const nodeCount = rng.intBetween(1, 8);
  const nodeIds = Array.from({ length: nodeCount }, (_, i) => `n${i}`);
  const nodes = nodeIds.map((id) => ({
    id,
    role: "implementer" as const,
    objective: `Do ${id}`,
    acceptanceCriteria: ["Done"],
    limits: { maxTokens: 1000, maxToolCalls: 10 },
  }));

  const edges: GraphSpec["edges"] = [];
  // Only forward edges (i < j over a fixed node order): always acyclic by construction.
  for (let i = 0; i < nodeIds.length; i += 1) {
    for (let j = i + 1; j < nodeIds.length; j += 1) {
      if (rng.bool(0.35)) {
        edges.push({
          from: nodeIds[i] as string,
          to: nodeIds[j] as string,
          condition: rng.bool(0.5) ? "result_ready" : "accepted",
        });
      }
    }
  }

  return { schemaVersion: 1, id: `${runId}-graph`, runId, depth: 0, revision: 1, nodes, edges };
}

const FAILURE_CATEGORIES: readonly FailureCategory[] = ["worker_crashed", "check_failed", "deadline_exceeded"];

/**
 * A seeded, deterministic run of one random small graph through a fake host: a fake worker
 * answers dispatches (result/failure/lease-expiry, sometimes stale, late, or duplicated) and
 * a fake acceptance gate answers `evaluate_acceptance` at random. Every applied event is
 * checked against the reducer's invariants before the next one is delivered.
 */
export function simulate(seed: number, options: SimOptions = {}): SimResult {
  const maxSteps = options.maxSteps ?? 500;
  const rng = new Prng(seed);
  const runId = `run-${seed}`;
  const graph = randomGraph(rng, runId);
  const policy = { maxConcurrent: rng.intBetween(1, 3), maxAttemptsPerNode: rng.intBetween(1, 3) };

  let nextId = 0;
  const makeId = (label: string): string => `${label}-${seed}-${nextId++}`;
  const at = (): string => new Date(2026, 0, 1, 0, 0, 0, nextId).toISOString();

  let state: RunState = initialState();
  const journal: JournalEvent[] = [];
  const inbox: JournalEvent[] = [];
  const deferred: { releaseAt: number; event: JournalEvent }[] = [];
  let sawAcceptedCancel = false;

  // attemptId -> outstanding: an `evaluate_acceptance` command was issued but no
  // `acceptance_decided` for it has been applied yet. Must be empty once the run is terminal.
  const outstandingAcceptance = new Set<string>();
  // The last observed disposition per node, to catch a disposition changing away from
  // `accepted` once set.
  const lastDisposition = new Map<string, ResultDisposition | null>();

  const willCancel = rng.bool(0.3);
  const cancelAtStep = willCancel ? rng.intBetween(1, 30) : -1;

  function enqueue(
    event: JournalEvent,
    { delay = false, duplicate = false }: { delay?: boolean; duplicate?: boolean } = {},
  ): void {
    if (delay && rng.bool(0.5)) {
      deferred.push({ releaseAt: step + rng.intBetween(1, 4), event });
    } else {
      inbox.push(event);
    }
    if (duplicate && rng.bool(0.25)) {
      // A duplicate delivery: sometimes the exact same event ID (true replay of the same
      // fact), sometimes a fresh one (a host that lost track and re-derived the same fact).
      inbox.push(rng.bool(0.5) ? event : { ...event, eventId: makeId("dup") });
    }
  }

  function scheduleWorkerOutcome(attemptId: string, fencingToken: number): void {
    const roll = rng.float();
    if (roll < 0.7) {
      enqueue(
        {
          type: "result_proposed",
          schemaVersion: 1,
          eventId: makeId("rp"),
          runId,
          at: at(),
          attemptId,
          fencingToken,
          proposalDigest: "sha256:sim-result",
        },
        { delay: true, duplicate: true },
      );
    } else if (roll < 0.85) {
      enqueue(
        {
          type: "attempt_failed",
          schemaVersion: 1,
          eventId: makeId("af"),
          runId,
          at: at(),
          attemptId,
          fencingToken,
          category: rng.pick(FAILURE_CATEGORIES),
        },
        { delay: true, duplicate: true },
      );
    } else {
      enqueue(
        { type: "lease_expired", schemaVersion: 1, eventId: makeId("le"), runId, at: at(), attemptId, fencingToken },
        { delay: true, duplicate: true },
      );
    }
    // A fenced-out writer using the wrong token for this attempt: always expected to be
    // rejected (`stale_fencing_token` or `invalid_transition`), never to crash `decide`.
    if (rng.bool(0.15)) {
      enqueue({
        type: "result_proposed",
        schemaVersion: 1,
        eventId: makeId("stale"),
        runId,
        at: at(),
        attemptId,
        fencingToken: fencingToken + 1000,
        proposalDigest: "sha256:stale",
      });
    }
    // A late report for an attempt ID nobody will recognize by the time it arrives.
    if (rng.bool(0.1)) {
      enqueue(
        {
          type: "result_proposed",
          schemaVersion: 1,
          eventId: makeId("ghost"),
          runId,
          at: at(),
          attemptId: makeId("ghost-attempt"),
          fencingToken,
          proposalDigest: "sha256:ghost",
        },
        { delay: true },
      );
    }
  }

  function handleCommand(command: Command): void {
    if (command.type === "dispatch") {
      // The worker only starts once it actually has the assignment: its response is
      // scheduled from the confirmed `attempt_dispatched` event below, not from here.
      // Scheduling it here too could let it race ahead of, and be rejected before, the
      // confirmation it depends on, permanently losing the run's only progress signal.
      enqueue(
        {
          type: "attempt_dispatched",
          schemaVersion: 1,
          eventId: makeId("ad"),
          runId,
          at: at(),
          nodeId: command.nodeId,
          attemptId: command.attemptId,
          fencingToken: command.fencingToken,
        },
        { delay: true, duplicate: true },
      );
    } else if (command.type === "evaluate_acceptance") {
      // The gate answers `evaluate_acceptance` no matter the run's current status: a
      // cancelling run must stay live until this decision (or its later duplicate/conflict)
      // is applied, not disappear underneath it.
      const decision = rng.bool(0.6) ? "accepted" : "rejected";
      enqueue(
        {
          type: "acceptance_decided",
          schemaVersion: 1,
          eventId: makeId("acc"),
          runId,
          at: at(),
          nodeId: command.nodeId,
          attemptId: command.attemptId,
          decision,
          receiptIds: [],
        },
        { delay: true, duplicate: true },
      );
      // A second, independently decided (and possibly conflicting) evaluation of the same
      // attempt, e.g. two acceptance workers racing on the same proposal: whichever of the
      // two lands second must be rejected by the reducer, since the attempt is already decided.
      if (rng.bool(0.2)) {
        enqueue(
          {
            type: "acceptance_decided",
            schemaVersion: 1,
            eventId: makeId("acc2"),
            runId,
            at: at(),
            nodeId: command.nodeId,
            attemptId: command.attemptId,
            decision: rng.bool(0.5) ? "accepted" : "rejected",
            receiptIds: [],
          },
          { delay: true },
        );
      }
    } else if (command.type === "cancel_attempt") {
      enqueue(
        {
          type: "attempt_stopped",
          schemaVersion: 1,
          eventId: makeId("stop"),
          runId,
          at: at(),
          attemptId: command.attemptId,
        },
        { delay: true, duplicate: true },
      );
    }
    // `complete_run` has no further effect to simulate.
  }

  function checkInvariants(commands: readonly Command[]): void {
    const reservedCount = Object.values(state.nodes).filter((node) => node.execution === "ready").length;
    const heldAttempts = Object.values(state.attempts).filter(
      (attempt) => attempt.status === "dispatched" || attempt.status === "stopping",
    ).length;
    assert.equal(
      state.permitsInUse,
      reservedCount + heldAttempts,
      `seed ${seed}: permitsInUse (${state.permitsInUse}) does not match held permits (${reservedCount + heldAttempts})`,
    );
    if (state.policy !== null) {
      assert.ok(
        state.permitsInUse <= state.policy.maxConcurrent,
        `seed ${seed}: permitsInUse ${state.permitsInUse} exceeds maxConcurrent ${state.policy.maxConcurrent}`,
      );
    }

    const liveAttemptsByNode = new Map<string, number>();
    for (const attempt of Object.values(state.attempts)) {
      if (attempt.status === "dispatched" || attempt.status === "stopping") {
        liveAttemptsByNode.set(attempt.nodeId, (liveAttemptsByNode.get(attempt.nodeId) ?? 0) + 1);
      }
    }
    for (const [nodeId, count] of liveAttemptsByNode) {
      assert.ok(count <= 1, `seed ${seed}: node ${nodeId} has ${count} live attempts at once`);
    }

    for (const command of commands) {
      if (command.type !== "dispatch") continue;
      assert.ok(
        !sawAcceptedCancel,
        `seed ${seed}: dispatched node ${command.nodeId} after cancel_requested was accepted`,
      );
      const graphNow = state.graph;
      if (graphNow === null) continue;
      for (const edge of graphNow.edges) {
        if (edge.to !== command.nodeId) continue;
        const producer = state.nodes[edge.from];
        if (producer === undefined) continue;
        const producerStatus =
          producer.disposition === null
            ? { execution: producer.execution }
            : { execution: producer.execution, disposition: producer.disposition };
        assert.ok(
          isDependencySatisfied(edge.condition, producerStatus),
          `seed ${seed}: dispatched ${command.nodeId} before producer ${edge.from} satisfied its ${edge.condition} edge`,
        );
      }
    }

    for (const [nodeId, node] of Object.entries(state.nodes)) {
      if (lastDisposition.get(nodeId) === "accepted") {
        assert.equal(
          node.disposition,
          "accepted",
          `seed ${seed}: node ${nodeId} disposition changed away from accepted`,
        );
      }
      assert.ok(
        !(node.execution === "exhausted" && node.disposition === "accepted"),
        `seed ${seed}: node ${nodeId} is exhausted with an accepted disposition`,
      );
      lastDisposition.set(nodeId, node.disposition);
    }

    if (isTerminalStatus(state.status)) {
      assert.equal(
        outstandingAcceptance.size,
        0,
        `seed ${seed}: run became ${state.status} with outstanding evaluate_acceptance for attempts: ${[...outstandingAcceptance].join(", ")}`,
      );
      if (state.status === "succeeded") {
        for (const [nodeId, node] of Object.entries(state.nodes)) {
          assert.ok(
            node.execution === "result_ready" && node.disposition === "accepted",
            `seed ${seed}: run succeeded but node ${nodeId} is ${node.execution}/${String(node.disposition)}, not result_ready/accepted`,
          );
        }
      }
    }
  }

  function applyOne(event: JournalEvent): void {
    const prior = state;
    const result = decide(state, event);
    if (result.rejection !== undefined) {
      assert.deepStrictEqual(
        result.state,
        prior,
        `seed ${seed}: rejection ${result.rejection.code} on ${event.type} mutated state`,
      );
      state = result.state;
      return;
    }
    state = result.state;
    journal.push(event);
    if (event.type === "cancel_requested") sawAcceptedCancel = true;
    if (event.type === "attempt_dispatched") scheduleWorkerOutcome(event.attemptId, event.fencingToken);
    if (event.type === "acceptance_decided") outstandingAcceptance.delete(event.attemptId);
    for (const command of result.commands) {
      if (command.type === "evaluate_acceptance") outstandingAcceptance.add(command.attemptId);
    }
    checkInvariants(result.commands);
    for (const command of result.commands) handleCommand(command);
  }

  let step = 0;
  applyOne({ type: "run_started", schemaVersion: 1, eventId: makeId("start"), runId, at: at(), graph, policy });

  while (step < maxSteps && !isTerminalStatus(state.status)) {
    step += 1;

    for (let i = deferred.length - 1; i >= 0; i -= 1) {
      const item = deferred[i] as { releaseAt: number; event: JournalEvent };
      if (item.releaseAt <= step) {
        inbox.push(item.event);
        deferred.splice(i, 1);
      }
    }

    if (willCancel && step === cancelAtStep && state.status === "running") {
      inbox.push({
        type: "cancel_requested",
        schemaVersion: 1,
        eventId: makeId("cancel"),
        runId,
        at: at(),
        reason: "simulated operator cancellation",
      });
    }

    if (inbox.length === 0) {
      if (deferred.length === 0) break; // genuine deadlock: caught by the liveness assertion below
      continue;
    }

    const index = rng.int(inbox.length);
    const event = inbox.splice(index, 1)[0] as JournalEvent;
    applyOne(event);
  }

  assert.ok(
    isTerminalStatus(state.status),
    `seed ${seed}: run did not reach a terminal status within ${maxSteps} steps (status: ${state.status})`,
  );

  const replayed = replay(journal);
  assert.deepStrictEqual(
    replayed.rejections,
    [],
    `seed ${seed}: replay(journal) rejected an event from the accepted log`,
  );
  assert.deepStrictEqual(replayed.state, state, `seed ${seed}: replay(journal) does not match the live final state`);

  return { seed, steps: step, finalState: state, journal };
}
