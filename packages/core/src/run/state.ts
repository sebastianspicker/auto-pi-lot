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
 * marks a rejected attempt that was retried under a new attempt ID instead. `invalidated` marks
 * a proposed or accepted result whose consumed producer attempt was superseded or rejected
 * (decision 0005).
 */
export type AttemptStatus =
  | "dispatched"
  | "result_ready"
  | "accepted"
  | "rejected"
  | "failed"
  | "stopping"
  | "stopped"
  | "superseded"
  | "invalidated";

export interface AttemptState {
  readonly nodeId: string;
  readonly fencingToken: number;
  readonly status: AttemptStatus;
  /**
   * The candidate binding: producer node ID -> the producer attempt this attempt consumed, for
   * every producer of the node (both edge conditions) at reservation time.
   */
  readonly consumes: Readonly<Record<string, string>>;
  /**
   * Set when a producer attempt this attempt consumed was superseded or rejected. An
   * invalidated attempt's outcome never counts against the node's retry allowance.
   */
  readonly invalidated: boolean;
}

/** The most recent rejecting `acceptance_decided` for a node, handed to its next dispatch. */
export interface RejectionRef {
  readonly attemptId: string;
  readonly receiptIds: readonly string[];
}

export interface NodeRunState {
  readonly execution: ExecutionState;
  readonly disposition: ResultDisposition | null;
  /** Every dispatched attempt; it also numbers attempt IDs, so it never decreases. */
  readonly attemptCount: number;
  /**
   * Attempts that ended because they were invalidated. The retry allowance is
   * `attemptCount - invalidatedAttemptCount < maxAttemptsPerNode`.
   */
  readonly invalidatedAttemptCount: number;
  readonly activeAttemptId: string | null;
  readonly failureCategory: FailureCategory | null;
  /**
   * A reservation the reducer made for the next attempt on this node, persisted-before-dispatch:
   * `decide` never reserves a second attempt for the same node until `attempt_dispatched`
   * confirms this one (clearing the reservation) or cancellation drops it.
   */
  readonly reservedAttemptId: string | null;
  readonly reservedFencingToken: number | null;
  /** The candidate binding computed at reservation, moved onto the attempt on `attempt_dispatched`. */
  readonly reservedConsumes: Readonly<Record<string, string>> | null;
  /**
   * The reducer has emitted `evaluate_acceptance` for the current result. Reset whenever the
   * node leaves `result_ready`.
   */
  readonly acceptanceRequested: boolean;
  readonly lastRejection: RejectionRef | null;
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
    invalidatedAttemptCount: 0,
    activeAttemptId: null,
    failureCategory: null,
    reservedAttemptId: null,
    reservedFencingToken: null,
    reservedConsumes: null,
    acceptanceRequested: false,
    lastRejection: null,
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
