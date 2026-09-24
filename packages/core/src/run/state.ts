import type { ValidatedGraph } from "../graph/validate.js";
import type { RunPolicy } from "./events.js";
import type { ExecutionState, FailureCategory, ResultDisposition } from "./status.js";

/**
 * `RunState` is plain, readonly, JSON-serializable data: no `Map`/`Set`, and every optional
 * dimension is `null` rather than an omitted key, so `canonicalJson`/`deepEqual` compare two
 * states structurally instead of tripping over `undefined` vs. missing properties.
 */
export type RunStatus = "not_started" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";

/**
 * An attempt holds a run permit while `dispatched` or `stopping`; `result_ready` released
 * its permit when the proposal arrived. `accepted`/`rejected` mark an attempt's acceptance
 * decision as final: once set, a later `acceptance_decided` for the same attempt is rejected
 * rather than re-applied, which is what makes acceptance idempotent per attempt. `superseded`
 * marks a rejected attempt that was retried under a new attempt ID instead.
 */
export type AttemptStatus =
  | "dispatched"
  | "result_ready"
  | "accepted"
  | "rejected"
  | "failed"
  | "stopping"
  | "stopped"
  | "superseded";

export interface AttemptState {
  readonly nodeId: string;
  readonly fencingToken: number;
  readonly status: AttemptStatus;
}

export interface NodeRunState {
  readonly execution: ExecutionState;
  readonly disposition: ResultDisposition | null;
  readonly attemptCount: number;
  readonly activeAttemptId: string | null;
  readonly failureCategory: FailureCategory | null;
  /**
   * A reservation the reducer made for the next attempt on this node, persisted-before-dispatch:
   * `decide` never reserves a second attempt for the same node until `attempt_dispatched`
   * confirms this one (clearing the reservation) or cancellation drops it.
   */
  readonly reservedAttemptId: string | null;
  readonly reservedFencingToken: number | null;
}

export interface RunState {
  readonly runId: string | null;
  readonly status: RunStatus;
  readonly graph: ValidatedGraph | null;
  readonly policy: RunPolicy | null;
  readonly nodes: Readonly<Record<string, NodeRunState>>;
  readonly attempts: Readonly<Record<string, AttemptState>>;
  readonly permitsInUse: number;
  readonly appliedEventIds: Readonly<Record<string, true>>;
  readonly lastFencingToken: number;
}

export function freshNodeState(): NodeRunState {
  return {
    execution: "pending",
    disposition: null,
    attemptCount: 0,
    activeAttemptId: null,
    failureCategory: null,
    reservedAttemptId: null,
    reservedFencingToken: null,
  };
}

/** The state before any `run_started` event has been applied. */
export function initialState(): RunState {
  return {
    runId: null,
    status: "not_started",
    graph: null,
    policy: null,
    nodes: {},
    attempts: {},
    permitsInUse: 0,
    appliedEventIds: {},
    lastFencingToken: 0,
  };
}

export function isTerminalStatus(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
