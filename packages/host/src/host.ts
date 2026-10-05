import { randomUUID } from "node:crypto";

import {
  type AcceptanceGate,
  AcceptanceVerdictSchema,
  type Command,
  type DispatchCommand,
  decide,
  type GraphSpec,
  initialState,
  type JournalEvent,
  type JournalStore,
  parseDto,
  parseJournalEvent,
  type Rejection,
  type ReplayRejection,
  type RunCompletionStatus,
  type RunPolicy,
  type RunState,
  type RunStatus,
  replay,
  type ValidationIssue,
  validateGraph,
  type WorkerOutcome,
  WorkerOutcomeSchema,
  type WorkerPort,
} from "@auto-pi-lot/core";

export interface HostPorts {
  readonly journal: JournalStore;
  readonly worker: WorkerPort;
  readonly gate: AcceptanceGate;
  /** Host-owned time and ids; injectable so tests are deterministic. Defaults: `new Date()` and `crypto.randomUUID()`. */
  readonly clock?: () => Date;
  readonly newEventId?: () => string;
}

/** An event the reducer rejected. It was never persisted and did not change the state. */
export interface HostRejection {
  readonly event: JournalEvent;
  readonly rejection: Rejection;
}

/** What a worker did wrong at the port boundary: its outcome did not match `WorkerOutcomeSchema`. */
export interface ProtocolViolation {
  readonly attemptId: string;
  readonly issues: readonly ValidationIssue[];
}

/**
 * `rejected`: the reducer refused the event (recorded in `rejections`). `invalid`: the event the
 * host built does not satisfy the event schema, so it was never decided or stored.
 */
export type SubmitResult =
  | { readonly applied: true; readonly commands: readonly Command[] }
  | { readonly applied: false; readonly reason: "rejected"; readonly rejection: Rejection }
  | { readonly applied: false; readonly reason: "invalid"; readonly issues: readonly ValidationIssue[] };

/** The acceptance gate returned a verdict that breaks the port contract. The gate is host policy, so this is a host bug. */
export class GateProtocolError extends Error {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly issues: readonly ValidationIssue[];

  constructor(nodeId: string, attemptId: string, issues: readonly ValidationIssue[]) {
    super(
      `Acceptance gate returned an invalid verdict for attempt ${attemptId} of node ${nodeId}: ${issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
    this.name = "GateProtocolError";
    this.nodeId = nodeId;
    this.attemptId = attemptId;
    this.issues = issues;
  }
}

const MAX_REJECTIONS = 200;
const MAX_PROTOCOL_VIOLATIONS = 100;

/** A persisted log must replay without a single rejection; one that does not is corrupt. */
export class JournalReplayError extends Error {
  readonly runId: string;
  readonly rejections: readonly ReplayRejection[];

  constructor(runId: string, rejections: readonly ReplayRejection[]) {
    super(
      `Journal of run ${runId} does not replay cleanly: ${rejections
        .map((entry) => `${entry.eventId}: ${entry.rejection.code} (${entry.rejection.message})`)
        .join("; ")}`,
    );
    this.name = "JournalReplayError";
    this.runId = runId;
    this.rejections = rejections;
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event before the host stamps it with schema version, id, run and time. */
type EventBody = DistributiveOmit<JournalEvent, "schemaVersion" | "eventId" | "runId" | "at">;

interface Recovery {
  readonly tornTail: boolean;
}

function completionOf(status: RunStatus): RunCompletionStatus | null {
  return status === "succeeded" || status === "failed" || status === "cancelled" ? status : null;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Runs one task graph through the pure reducer. Invariants:
 * - One event at a time: every submission goes through `submit`, a FIFO chain, and command
 *   handlers only ever enqueue further events (they run detached, never inside the chain).
 * - Persist before act: an applied event is appended to the journal first; the host state
 *   advances and its commands run only once the append resolved.
 * - A worker starts only after the `attempt_dispatched` event for its attempt was applied and
 *   persisted.
 * - Outcomes come back only as events. A failed append or gate stops the host (`failure`).
 */
export class RunHost {
  /** Resolves with the run's terminal status once `complete_run` was emitted; rejects with `failure`. */
  readonly completion: Promise<RunCompletionStatus>;
  readonly recovery: Recovery;

  readonly #ports: HostPorts;
  readonly #runId: string;
  readonly #events: JournalEvent[];
  readonly #rejections: HostRejection[] = [];
  readonly #protocolViolations: ProtocolViolation[] = [];
  readonly #proposalDigests = new Map<string, string>();
  /** Attempts whose worker was started; `cancel` goes only to those. */
  readonly #started = new Set<string>();
  #rejectedCount = 0;
  readonly #resolveCompletion: (status: RunCompletionStatus) => void;
  readonly #rejectCompletion: (error: Error) => void;
  #state: RunState;
  #tail: Promise<unknown> = Promise.resolve();
  #failure: Error | null = null;

  private constructor(
    ports: HostPorts,
    runId: string,
    events: readonly JournalEvent[],
    state: RunState,
    recovery: Recovery,
  ) {
    this.#ports = ports;
    this.#runId = runId;
    this.#events = [...events];
    this.#state = state;
    this.recovery = recovery;
    for (const event of events) this.#recordDigest(event);
    let resolve: (status: RunCompletionStatus) => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    this.completion = new Promise<RunCompletionStatus>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.#resolveCompletion = resolve;
    this.#rejectCompletion = reject;
    // A failure is also observable through `failure`; do not turn an unobserved rejection into a crash.
    this.completion.catch(() => undefined);
  }

  /** Admits a new run: validates the graph, persists `run_started`, then drives the run. */
  static async start(ports: HostPorts, graph: GraphSpec, policy: RunPolicy): Promise<RunHost> {
    const validated = validateGraph(graph);
    if (!validated.ok) {
      throw new Error(`Invalid graph: ${validated.issues.map((issue) => issue.message).join("; ")}`);
    }
    const runId = validated.graph.runId;
    const existing = await ports.journal.read(runId);
    if (existing.events.length > 0) throw new Error(`Run ${runId} already has a journal; use RunHost.resume`);
    const host = new RunHost(ports, runId, [], initialState(), { tornTail: false });
    const result = await host.submit({ type: "run_started", graph: validated.graph, policy });
    if (!result.applied) {
      const why =
        result.reason === "rejected"
          ? result.rejection.message
          : result.issues.map((issue) => issue.message).join("; ");
      throw new Error(`run_started was refused: ${why}`);
    }
    return host;
  }

  /** Rebuilds a run from its journal, then reconciles what the previous process left in flight. */
  static async resume(ports: HostPorts, runId: string): Promise<RunHost> {
    const stored = await ports.journal.read(runId);
    const replayed = replay(stored.events);
    if (replayed.rejections.length > 0) throw new JournalReplayError(runId, replayed.rejections);
    if (stored.events.length === 0) throw new Error(`No journal found for run ${runId}`);
    const host = new RunHost(ports, runId, stored.events, replayed.state, { tornTail: stored.tornTail });
    await host.#reconcile();
    return host;
  }

  get runId(): string {
    return this.#runId;
  }

  get state(): RunState {
    return this.#state;
  }

  /** Applied events in order, including the ones replayed on resume. */
  get events(): readonly JournalEvent[] {
    return this.#events;
  }

  /**
   * The most recent events the reducer rejected (never persisted), at most the last 200 so a
   * misbehaving worker cannot grow memory without bound. `rejectedCount` is the total.
   */
  get rejections(): readonly HostRejection[] {
    return this.#rejections;
  }

  /** How many events the reducer rejected since this host was created, including those no longer in `rejections`. */
  get rejectedCount(): number {
    return this.#rejectedCount;
  }

  /** The most recent worker outcomes that broke the port contract (at most the last 100). */
  get protocolViolations(): readonly ProtocolViolation[] {
    return this.#protocolViolations;
  }

  get failure(): Error | null {
    return this.#failure;
  }

  cancel(reason: string): Promise<SubmitResult> {
    return this.submit({ type: "cancel_requested", reason });
  }

  /**
   * Reports a worker outcome for an attempt (what the worker port's `report` callback does).
   * The outcome comes from an untrusted worker, so it is validated first; a malformed one is a
   * protocol violation by the worker and fails that attempt as `schema_invalid`.
   */
  async report(attemptId: string, fencingToken: number, outcome: WorkerOutcome): Promise<SubmitResult> {
    const untrusted: unknown = outcome;
    const parsed = parseDto(WorkerOutcomeSchema, untrusted);
    if (!parsed.ok) {
      this.#protocolViolations.push({ attemptId, issues: parsed.issues });
      if (this.#protocolViolations.length > MAX_PROTOCOL_VIOLATIONS) this.#protocolViolations.shift();
      return this.submit({ type: "attempt_failed", attemptId, fencingToken, category: "schema_invalid" });
    }
    const valid = parsed.value;
    switch (valid.type) {
      case "result":
        return this.#reportResult(attemptId, fencingToken, valid.proposalDigest);
      case "failed":
        return this.submit({ type: "attempt_failed", attemptId, fencingToken, category: valid.category });
      case "stopped":
        return this.submit({ type: "attempt_stopped", attemptId });
    }
  }

  /**
   * A result that raced a stop request is rejected by the reducer (the attempt is `stopping`),
   * and a worker reports only once, so no `attempt_stopped` would ever follow. The worker is done,
   * so the host confirms the stop itself; otherwise the attempt would hold its permit forever.
   */
  async #reportResult(attemptId: string, fencingToken: number, proposalDigest: string): Promise<SubmitResult> {
    const result = await this.submit({ type: "result_proposed", attemptId, fencingToken, proposalDigest });
    // `stale_candidate` (the run no longer wants a candidate) and `invalid_transition` (the attempt
    // is not awaiting a result) are exactly how the reducer refuses a result for a `stopping`
    // attempt; any other rejection (such as a stale fencing token) is not the "already reported" case.
    if (
      !result.applied &&
      result.reason === "rejected" &&
      (result.rejection.code === "stale_candidate" || result.rejection.code === "invalid_transition")
    ) {
      const attempt = this.#state.attempts[attemptId];
      if (attempt?.status === "stopping" && attempt.fencingToken === fencingToken) {
        await this.submit({ type: "attempt_stopped", attemptId });
      }
    }
    return result;
  }

  /** Enqueues one event on the FIFO chain. Never call it from inside the chain and await it. */
  private submit(body: EventBody): Promise<SubmitResult> {
    const run = this.#tail.then(() => this.#process(body));
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** The critical section: check, decide, persist, advance, then hand the commands off. */
  async #process(body: EventBody): Promise<SubmitResult> {
    if (this.#failure !== null) throw this.#failure;
    try {
      const built = this.#buildEvent(body);
      // The event was never decided or stored; a bad submission is not a host failure.
      if (!built.ok) return { applied: false, reason: "invalid", issues: built.issues };
      const event = built.value;
      const decided = decide(this.#state, event);
      if (decided.rejection !== undefined) {
        this.#rejectedCount += 1;
        this.#rejections.push({ event, rejection: decided.rejection });
        if (this.#rejections.length > MAX_REJECTIONS) this.#rejections.shift();
        return { applied: false, reason: "rejected", rejection: decided.rejection };
      }
      await this.#ports.journal.append(event); // durable before anything else changes
      this.#state = decided.state;
      this.#events.push(event);
      this.#recordDigest(event);
      this.#execute(decided.commands);
      return { applied: true, commands: decided.commands };
    } catch (error) {
      throw this.#fail(error);
    }
  }

  #buildEvent(body: EventBody): ReturnType<typeof parseJournalEvent> {
    const clock = this.#ports.clock ?? (() => new Date());
    const newEventId = this.#ports.newEventId ?? randomUUID;
    return parseJournalEvent({
      ...body,
      schemaVersion: 1,
      eventId: newEventId(),
      runId: this.#runId,
      at: clock().toISOString(),
    });
  }

  #recordDigest(event: JournalEvent): void {
    if (event.type === "result_proposed") this.#proposalDigests.set(event.attemptId, event.proposalDigest);
  }

  #fail(error: unknown): Error {
    const failure = this.#failure ?? toError(error);
    if (this.#failure === null) {
      this.#failure = failure;
      this.#rejectCompletion(failure);
    }
    return failure;
  }

  /** Runs each command as its own detached task, in order; a task's error stops the host. */
  #execute(commands: readonly Command[]): void {
    for (const command of commands) {
      this.#run(command).catch((error: unknown) => {
        this.#fail(error);
      });
    }
  }

  async #run(command: Command): Promise<void> {
    switch (command.type) {
      case "dispatch":
        return this.#dispatch(command);
      case "cancel_attempt":
        return this.#cancelAttempt(command.attemptId);
      case "evaluate_acceptance":
        return this.#evaluate(command.nodeId, command.attemptId);
      case "complete_run":
        this.#resolveCompletion(command.status);
        return;
    }
  }

  /** Persist the dispatch intent; only when that event applied does the worker start. */
  async #dispatch(command: DispatchCommand): Promise<void> {
    const dispatched = await this.submit({
      type: "attempt_dispatched",
      nodeId: command.nodeId,
      attemptId: command.attemptId,
      fencingToken: command.fencingToken,
    });
    if (!dispatched.applied) return;
    const { attemptId, fencingToken } = command;
    // A cancel that landed between persisting the dispatch and now: the worker never ran, so the host confirms the stop.
    if (this.#state.attempts[attemptId]?.status === "stopping") {
      await this.submit({ type: "attempt_stopped", attemptId });
      return;
    }
    const node = this.#state.graph?.nodes.find((candidate) => candidate.id === command.nodeId);
    if (node === undefined) throw new Error(`Dispatched node ${command.nodeId} is not in the graph`);
    this.#started.add(attemptId);
    try {
      this.#ports.worker.start(
        {
          runId: this.#runId,
          nodeId: command.nodeId,
          attemptId,
          fencingToken,
          node,
          consumes: command.consumes,
          repairOf: command.repairOf,
        },
        (outcome) => {
          // A failed append is already recorded in `failure` by `submit`.
          this.report(attemptId, fencingToken, outcome).catch(() => undefined);
        },
      );
    } catch {
      // A worker that cannot start is a failed worker, not a host failure.
      this.#started.delete(attemptId);
      await this.submit({ type: "attempt_failed", attemptId, fencingToken, category: "worker_crashed" });
    }
  }

  /** Only a started worker knows the attempt; an unstarted one is stopped by `#dispatch` itself. */
  #cancelAttempt(attemptId: string): void {
    if (this.#started.has(attemptId)) this.#ports.worker.cancel(attemptId);
  }

  /** Asks the gate and reports its verdict as `acceptance_decided`. A gate error stops the host. */
  async #evaluate(nodeId: string, attemptId: string): Promise<void> {
    const node = this.#state.graph?.nodes.find((candidate) => candidate.id === nodeId);
    const proposalDigest = this.#proposalDigests.get(attemptId);
    if (node === undefined || proposalDigest === undefined) {
      throw new Error(`Cannot evaluate attempt ${attemptId}: no proposed result for node ${nodeId}`);
    }
    const answer: unknown = await this.#ports.gate.evaluate({
      runId: this.#runId,
      nodeId,
      attemptId,
      node,
      proposalDigest,
    });
    const verdict = parseDto(AcceptanceVerdictSchema, answer);
    if (!verdict.ok) throw new GateProtocolError(nodeId, attemptId, verdict.issues);
    await this.submit({
      type: "acceptance_decided",
      nodeId,
      attemptId,
      decision: verdict.value.decision,
      receiptIds: verdict.value.receiptIds,
    });
  }

  /**
   * Recovery after replay. The previous process owned every in-flight worker and is gone, so:
   * (a) each `dispatched` or `stopping` attempt loses its lease (the reducer retries it under a
   * new fencing token, which fences out the old worker); (b) a reservation whose
   * `attempt_dispatched` never became durable is dispatched now; (c) a result still waiting for
   * a verdict goes back to the gate (the reducer rejects a second verdict for an attempt).
   * (b) and (c) are read from the replayed state before (a) runs, so commands that (a) causes
   * are not issued twice.
   */
  async #reconcile(): Promise<void> {
    const replayed = this.#state;
    const done = completionOf(replayed.status);
    if (done !== null) {
      this.#resolveCompletion(done);
      return;
    }

    const commands: Command[] = [];
    for (const [nodeId, node] of Object.entries(replayed.nodes)) {
      if (node.execution === "ready" && node.reservedAttemptId !== null && node.reservedFencingToken !== null) {
        commands.push({
          type: "dispatch",
          nodeId,
          attemptId: node.reservedAttemptId,
          fencingToken: node.reservedFencingToken,
          consumes: node.reservedConsumes ?? {},
          repairOf: node.lastRejection,
        });
      }
      const activeId = node.activeAttemptId;
      if (
        node.execution === "result_ready" &&
        node.acceptanceRequested &&
        activeId !== null &&
        replayed.attempts[activeId]?.status === "result_ready"
      ) {
        commands.push({ type: "evaluate_acceptance", nodeId, attemptId: activeId });
      }
    }
    for (const [attemptId, attempt] of Object.entries(replayed.attempts)) {
      if (attempt.status !== "dispatched" && attempt.status !== "stopping") continue;
      await this.submit({ type: "lease_expired", attemptId, fencingToken: attempt.fencingToken });
    }
    this.#execute(commands);
  }
}
