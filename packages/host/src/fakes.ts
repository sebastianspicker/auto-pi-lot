import {
  type AcceptanceGate,
  type AcceptanceRequest,
  type AcceptanceVerdict,
  digest,
  type WorkerAssignment,
  type WorkerOutcome,
  type WorkerPort,
} from "@auto-pi-lot/core";

export type FakeMode = "immediate" | "manual";

export interface ScriptedWorkerOptions {
  /** Per node ID, the outcome of its 1st, 2nd, ... attempt. Exhausted or absent: a result. */
  readonly script?: Readonly<Record<string, readonly WorkerOutcome[]>>;
  /** `immediate` reports after `start`; `manual` holds the outcome until `release`. */
  readonly mode?: FakeMode;
}

interface RunningAttempt {
  readonly outcome: WorkerOutcome;
  readonly report: (outcome: WorkerOutcome) => void;
  done: boolean;
}

/** A worker that follows a script. It never touches the journal; it only reports outcomes. */
export class ScriptedWorker implements WorkerPort {
  readonly started: WorkerAssignment[] = [];
  readonly cancelled: string[] = [];
  readonly #script: Readonly<Record<string, readonly WorkerOutcome[]>>;
  readonly #mode: FakeMode;
  readonly #running = new Map<string, RunningAttempt>();
  readonly #attemptsPerNode = new Map<string, number>();

  constructor(options: ScriptedWorkerOptions = {}) {
    this.#script = options.script ?? {};
    this.#mode = options.mode ?? "immediate";
  }

  start(assignment: WorkerAssignment, report: (outcome: WorkerOutcome) => void): void {
    this.started.push(assignment);
    const index = this.#attemptsPerNode.get(assignment.nodeId) ?? 0;
    this.#attemptsPerNode.set(assignment.nodeId, index + 1);
    const scripted = Object.hasOwn(this.#script, assignment.nodeId)
      ? this.#script[assignment.nodeId]?.[index]
      : undefined;
    const outcome: WorkerOutcome = scripted ?? {
      type: "result",
      proposalDigest: digest({ nodeId: assignment.nodeId, attemptId: assignment.attemptId }),
    };
    this.#running.set(assignment.attemptId, { outcome, report, done: false });
    if (this.#mode === "immediate") queueMicrotask(() => this.release(assignment.attemptId));
  }

  /** Delivers the held outcome of an attempt. A no-op once the attempt has reported. */
  release(attemptId: string): void {
    const running = this.#running.get(attemptId);
    if (running === undefined || running.done) return;
    running.done = true;
    running.report(running.outcome);
  }

  cancel(attemptId: string): void {
    this.cancelled.push(attemptId);
    const running = this.#running.get(attemptId);
    if (running === undefined || running.done) return;
    running.done = true;
    running.report({ type: "stopped" });
  }
}

export interface ScriptedGateOptions {
  /** Answers a request; `undefined` falls back to accepting with a receipt of the attempt. */
  readonly verdicts?: (request: AcceptanceRequest) => AcceptanceVerdict | undefined;
  /** `immediate` answers at once; `manual` holds the answer until `release`. */
  readonly mode?: FakeMode;
}

/** An acceptance gate that follows a script. */
export class ScriptedGate implements AcceptanceGate {
  readonly requests: AcceptanceRequest[] = [];
  readonly #verdicts: (request: AcceptanceRequest) => AcceptanceVerdict | undefined;
  readonly #mode: FakeMode;
  readonly #held = new Map<string, () => void>();

  constructor(options: ScriptedGateOptions = {}) {
    this.#verdicts = options.verdicts ?? (() => undefined);
    this.#mode = options.mode ?? "immediate";
  }

  evaluate(request: AcceptanceRequest): Promise<AcceptanceVerdict> {
    this.requests.push(request);
    const verdict: AcceptanceVerdict = this.#verdicts(request) ?? {
      decision: "accepted",
      receiptIds: [`receipt:${request.attemptId}`],
    };
    if (this.#mode === "immediate") return Promise.resolve(verdict);
    return new Promise((resolve) => {
      this.#held.set(request.attemptId, () => resolve(verdict));
    });
  }

  /** Answers a held request. A no-op when none is held for the attempt. */
  release(attemptId: string): void {
    const answer = this.#held.get(attemptId);
    this.#held.delete(attemptId);
    answer?.();
  }
}
