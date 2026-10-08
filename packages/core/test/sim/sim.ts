import assert from "node:assert/strict";

import {
  type Command,
  decide,
  type FailureCategory,
  type GraphSpec,
  initialState,
  isDependencySatisfied,
  isTerminalStatus,
  isWriterRole,
  type JournalEvent,
  type ResultDisposition,
  type RunState,
  replay,
  validateGraph,
  writerSlotsOf,
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
  // Writer and reader roles are mixed so the writer-slot rule is exercised; roles do not
  // otherwise change what the reducer does.
  const nodes = nodeIds.map((id) => ({
    id,
    role: rng.bool(0.6) ? ("implementer" as const) : ("explorer" as const),
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

  // Drop every `result_ready` edge whose verifying node would wait for its producer's
  // acceptance: the reducer never sees such a graph. Dropping an edge removes paths only, so
  // it cannot make another edge invalid.
  let graph: GraphSpec = { schemaVersion: 1, id: `${runId}-graph`, runId, depth: 0, revision: 1, nodes, edges };
  for (let result = validateGraph(graph); !result.ok; result = validateGraph(graph)) {
    const dropped = new Set(result.issues.map((issue) => issue.path[1]));
    graph = { ...graph, edges: graph.edges.filter((_, index) => !dropped.has(index)) };
  }
  return graph;
}

function verifiersOf(state: RunState, nodeId: string): string[] {
  return (state.graph?.edges ?? [])
    .filter((edge) => edge.from === nodeId && edge.condition === "result_ready")
    .map((edge) => edge.to);
}

/** Independent oracle: every verifying node holds an accepted result bound to the producer's attempt. */
function verifiersAcceptedAndBound(state: RunState, nodeId: string): boolean {
  const candidate = state.nodes[nodeId]?.activeAttemptId ?? null;
  return verifiersOf(state, nodeId).every((verifierId) => {
    const verifier = state.nodes[verifierId];
    if (verifier === undefined || verifier.activeAttemptId === null) return false;
    const attempt = state.attempts[verifier.activeAttemptId];
    return (
      verifier.execution === "result_ready" &&
      verifier.disposition === "accepted" &&
      candidate !== null &&
      attempt?.consumes[nodeId] === candidate
    );
  });
}

const FAILURE_CATEGORIES: readonly FailureCategory[] = ["worker_crashed", "check_failed", "deadline_exceeded"];

/**
 * A seeded, deterministic run of one random small graph through a fake host: a fake worker
 * answers dispatches (result/failure/lease-expiry, sometimes stale, late, or duplicated) and
 * a fake acceptance gate answers `evaluate_acceptance` at random. Every applied event is
 * checked against the reducer's invariants before the next one is delivered.
 */
export function simulate(seed: number, options: SimOptions = {}): SimResult {
  const maxSteps = options.maxSteps ?? 800;
  const rng = new Prng(seed);
  const runId = `run-${seed}`;
  const graph = randomGraph(rng, runId);
  const maxConcurrent = rng.intBetween(1, 3);
  const basePolicy = rng.bool(0.5)
    ? { maxConcurrent, maxAttemptsPerNode: rng.intBetween(1, 3) }
    : {
        maxConcurrent,
        maxAttemptsPerNode: rng.intBetween(1, 3),
        maxConcurrentWriters: rng.intBetween(1, maxConcurrent),
      };

  const policy = { ...basePolicy, requireFinalVerification: rng.bool(0.5) };

  let nextId = 0;
  const makeId = (label: string): string => `${label}-${seed}-${nextId++}`;
  const at = (): string => new Date(2026, 0, 1, 0, 0, 0, nextId).toISOString();

  let state: RunState = initialState();
  const journal: JournalEvent[] = [];
  const inbox: JournalEvent[] = [];
  const deferred: { releaseAt: number; event: JournalEvent }[] = [];
  let sawAcceptedCancel = false;

  // Every attempt an `evaluate_acceptance` command was issued for. One is outstanding while its
  // result is still pending and the reducer still waits for the decision (a request withdrawn
  // because a verifying node was invalidated is not). None may be outstanding once terminal.
  const requestedAcceptance = new Set<string>();
  const outstandingAcceptance = (): string[] =>
    [...requestedAcceptance].filter((attemptId) => {
      const attempt = state.attempts[attemptId];
      const node = attempt === undefined ? undefined : state.nodes[attempt.nodeId];
      return attempt?.status === "result_ready" && node?.acceptanceRequested === true;
    });
  // The last observed disposition per node, to catch a disposition changing away from
  // `accepted` other than by invalidation, and to check verification only at the moment a node
  // becomes accepted.
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
          receiptIds: decision === "accepted" ? [makeId("receipt")] : [],
        },
        { delay: true, duplicate: true },
      );
      // An accepted decision without evidence: the reducer must reject it as `missing_evidence`.
      if (rng.bool(0.1)) {
        enqueue(
          {
            type: "acceptance_decided",
            schemaVersion: 1,
            eventId: makeId("noevidence"),
            runId,
            at: at(),
            nodeId: command.nodeId,
            attemptId: command.attemptId,
            decision: "accepted",
            receiptIds: [],
          },
          { delay: true },
        );
      }
      // A second, independently decided (and possibly conflicting) evaluation of the same
      // attempt, e.g. two acceptance workers racing on the same proposal: whichever of the
      // two lands second must be rejected by the reducer, since the attempt is already decided.
      if (rng.bool(0.2)) {
        const secondDecision = rng.bool(0.5) ? "accepted" : "rejected";
        enqueue(
          {
            type: "acceptance_decided",
            schemaVersion: 1,
            eventId: makeId("acc2"),
            runId,
            at: at(),
            nodeId: command.nodeId,
            attemptId: command.attemptId,
            decision: secondDecision,
            receiptIds: secondDecision === "accepted" ? [makeId("receipt")] : [],
          },
          { delay: true },
        );
      }
    } else if (command.type === "verify_run") {
      const passed = rng.bool(0.8);
      const checkProfileIds = [...new Set(graph.nodes.flatMap((node) => node.checks ?? []))];
      enqueue(
        {
          type: "run_verified",
          schemaVersion: 1,
          eventId: makeId("final"),
          runId,
          at: at(),
          result: {
            outcome: passed ? "passed" : "failed",
            sourceDigest: "sha256:final",
            checkProfileIds,
            checkReceiptIds: checkProfileIds.map(() => makeId("final-receipt")),
            reasons: passed ? [] : ["Final check failed"],
          },
        },
        { delay: true, duplicate: true },
      );
      if (rng.bool(0.3))
        enqueue({
          type: "cancel_requested",
          schemaVersion: 1,
          eventId: makeId("final-cancel"),
          runId,
          at: at(),
          reason: "Cancel during final checks",
        });
    } else if (command.type === "cancel_attempt") {
      // A worker asked to stop because its input was invalidated may still crash or lose its
      // lease before it confirms; both outcomes must be accepted.
      const attempt = state.attempts[command.attemptId];
      if (attempt?.invalidated === true && rng.bool(0.3)) {
        enqueue(
          rng.bool(0.5)
            ? {
                type: "attempt_failed",
                schemaVersion: 1,
                eventId: makeId("af"),
                runId,
                at: at(),
                attemptId: command.attemptId,
                fencingToken: attempt.fencingToken,
                category: rng.pick(FAILURE_CATEGORIES),
              }
            : {
                type: "lease_expired",
                schemaVersion: 1,
                eventId: makeId("le"),
                runId,
                at: at(),
                attemptId: command.attemptId,
                fencingToken: attempt.fencingToken,
              },
          { delay: true, duplicate: true },
        );
      } else {
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
    }
    // `complete_run` has no further effect to simulate.
  }

  /**
   * A host that decides on a `verifying` producer before the reducer asks: an early acceptance
   * must be rejected as `verification_incomplete`, an early rejection (fail fast) applies.
   */
  function scheduleEarlyDecisions(nodeId: string, attemptId: string): void {
    if (rng.bool(0.15)) {
      enqueue(
        {
          type: "acceptance_decided",
          schemaVersion: 1,
          eventId: makeId("early-accept"),
          runId,
          at: at(),
          nodeId,
          attemptId,
          decision: "accepted",
          receiptIds: [makeId("receipt")],
        },
        { delay: true },
      );
    }
    if (rng.bool(0.1)) {
      enqueue(
        {
          type: "acceptance_decided",
          schemaVersion: 1,
          eventId: makeId("early-reject"),
          runId,
          at: at(),
          nodeId,
          attemptId,
          decision: "rejected",
          receiptIds: [makeId("receipt")],
        },
        { delay: true },
      );
    }
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
    const runningCount = Object.values(state.nodes).filter((node) => node.execution === "running").length;
    assert.equal(
      state.permitsInUse,
      reservedCount + runningCount,
      `seed ${seed}: permitsInUse (${state.permitsInUse}) does not match ready plus running nodes`,
    );
    if (state.policy !== null) {
      assert.ok(
        state.permitsInUse <= state.policy.maxConcurrent,
        `seed ${seed}: permitsInUse ${state.permitsInUse} exceeds maxConcurrent ${state.policy.maxConcurrent}`,
      );
      const roles = new Map((state.graph?.nodes ?? []).map((node) => [node.id, node.role]));
      const writersHoldingPermits = Object.entries(state.nodes).filter(
        ([nodeId, node]) =>
          (node.execution === "ready" || node.execution === "running") && isWriterRole(roles.get(nodeId) ?? "explorer"),
      ).length;
      assert.ok(
        writersHoldingPermits <= writerSlotsOf(state.policy),
        `seed ${seed}: ${writersHoldingPermits} writers hold permits, more than the ${writerSlotsOf(state.policy)} writer slots`,
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
      const expectedConsumes: Record<string, string> = {};
      for (const edge of graphNow.edges) {
        if (edge.to !== command.nodeId) continue;
        const producer = state.nodes[edge.from];
        assert.ok(
          producer?.activeAttemptId != null,
          `seed ${seed}: dispatched ${command.nodeId} while producer ${edge.from} has no active attempt`,
        );
        expectedConsumes[edge.from] = producer.activeAttemptId;
        const producerStatus =
          producer.disposition === null
            ? { execution: producer.execution }
            : { execution: producer.execution, disposition: producer.disposition };
        assert.ok(
          isDependencySatisfied(edge.condition, producerStatus),
          `seed ${seed}: dispatched ${command.nodeId} before producer ${edge.from} satisfied its ${edge.condition} edge`,
        );
      }
      assert.deepStrictEqual(
        command.consumes,
        expectedConsumes,
        `seed ${seed}: dispatch of ${command.nodeId} is not bound to its producers' current attempts`,
      );
    }

    for (const command of commands) {
      if (command.type !== "evaluate_acceptance") continue;
      if (verifiersOf(state, command.nodeId).length === 0) continue;
      assert.ok(
        verifiersAcceptedAndBound(state, command.nodeId),
        `seed ${seed}: evaluate_acceptance for ${command.nodeId} before every verifying node accepted its attempt`,
      );
    }

    for (const [nodeId, node] of Object.entries(state.nodes)) {
      if (lastDisposition.get(nodeId) === "accepted") {
        assert.ok(
          node.disposition === "accepted" || node.disposition === "invalidated",
          `seed ${seed}: node ${nodeId} disposition changed from accepted to ${String(node.disposition)}`,
        );
      } else if (node.disposition === "accepted") {
        // Acceptance is a decision-time gate (decision 0005): an accepted verified producer has
        // every verifying node accepted and bound at the moment it is accepted. A verifying node
        // may later be invalidated through another producer while the producer stays accepted,
        // so this is not checked again afterwards.
        assert.ok(
          verifiersAcceptedAndBound(state, nodeId),
          `seed ${seed}: node ${nodeId} became accepted before every verifying node accepted its attempt`,
        );
      }
      if (state.policy !== null) {
        assert.ok(
          node.attemptCount - node.invalidatedAttemptCount <= state.policy.maxAttemptsPerNode,
          `seed ${seed}: node ${nodeId} spent more than ${state.policy.maxAttemptsPerNode} counted attempts`,
        );
      }
      if (node.execution === "running" && node.activeAttemptId !== null) {
        const attempt = state.attempts[node.activeAttemptId];
        if (attempt?.status === "stopping" && !attempt.invalidated) {
          assert.equal(
            state.status,
            "cancelling",
            `seed ${seed}: node ${nodeId} is stopping without invalidation outside cancellation`,
          );
        }
      }
      assert.ok(
        !(node.execution === "exhausted" && node.disposition === "accepted"),
        `seed ${seed}: node ${nodeId} is exhausted with an accepted disposition`,
      );
      lastDisposition.set(nodeId, node.disposition);
    }

    if (state.graph !== null) {
      for (const edge of state.graph.edges) {
        const producer = state.nodes[edge.from];
        const consumer = state.nodes[edge.to];
        if (producer === undefined || consumer === undefined) continue;
        if (producer.execution === "exhausted" || producer.execution === "failed") {
          assert.notEqual(
            consumer.execution,
            "pending",
            `seed ${seed}: node ${edge.to} is still pending after producer ${edge.from} ${producer.execution}`,
          );
        }
      }
    }
    for (const [nodeId, node] of Object.entries(state.nodes)) {
      if (node.execution === "failed") {
        assert.equal(
          node.failureCategory,
          "dependency_failed",
          `seed ${seed}: node ${nodeId} failed with category ${String(node.failureCategory)}`,
        );
      }
      if (state.status === "failed") {
        assert.ok(
          node.execution !== "pending" && node.execution !== "ready" && node.execution !== "running",
          `seed ${seed}: run failed but node ${nodeId} is ${node.execution}`,
        );
      }
      if (state.status === "running") {
        assert.notEqual(node.execution, "cancelled", `seed ${seed}: running run has cancelled node ${nodeId}`);
      }
    }

    if (isTerminalStatus(state.status)) {
      const outstanding = outstandingAcceptance();
      assert.equal(
        outstanding.length,
        0,
        `seed ${seed}: run became ${state.status} with outstanding evaluate_acceptance for attempts: ${outstanding.join(", ")}`,
      );
      assert.equal(state.verificationRequested, false, `seed ${seed}: terminal run still awaits final verification`);
      if (state.status === "succeeded") {
        if (policy.requireFinalVerification) assert.equal(state.verification?.outcome, "passed");
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
    if (event.type === "acceptance_decided" && event.eventId.startsWith("early-")) {
      const attempt = prior.attempts[event.attemptId];
      const node = prior.nodes[event.nodeId];
      if (prior.status === "running" && attempt?.status === "result_ready" && node?.disposition === "verifying") {
        if (event.decision === "rejected") {
          assert.equal(result.rejection, undefined, `seed ${seed}: early rejection of ${event.nodeId} was not applied`);
        } else if (!verifiersAcceptedAndBound(prior, event.nodeId)) {
          assert.equal(
            result.rejection?.code,
            "verification_incomplete",
            `seed ${seed}: early acceptance of ${event.nodeId} was not rejected as verification_incomplete`,
          );
        }
      }
    }
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
    if (event.type === "result_proposed") {
      const attempt = state.attempts[event.attemptId];
      if (attempt !== undefined && state.nodes[attempt.nodeId]?.disposition === "verifying") {
        scheduleEarlyDecisions(attempt.nodeId, event.attemptId);
      }
    }
    for (const command of result.commands) {
      if (command.type === "evaluate_acceptance") requestedAcceptance.add(command.attemptId);
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
