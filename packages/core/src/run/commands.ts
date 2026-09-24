/**
 * Commands are reducer-internal requests for effects that run outside `decide`. The host
 * performs the effect and reports back as a new journal event; `decide` never assumes a
 * command it emitted actually ran.
 *
 * Dispatch protocol: the host must persist and successfully apply `attempt_dispatched` (a
 * `decide` call that returns no rejection) before running the dispatch effect. A rejected
 * `attempt_dispatched` — for example, because the run was cancelled meanwhile — means the
 * effect must not run. Outcomes are never returned from the dispatch effect directly: they
 * arrive back as journal events (`result_proposed`, `attempt_failed`, `lease_expired`,
 * `attempt_stopped`) that the host persists and feeds back through `decide`. An
 * `evaluate_acceptance` command is likewise answered by an `acceptance_decided` event, never
 * a direct state mutation.
 */
export type RunCompletionStatus = "succeeded" | "failed" | "cancelled";

export interface DispatchCommand {
  readonly type: "dispatch";
  readonly nodeId: string;
  readonly attemptId: string;
  readonly fencingToken: number;
}

export interface EvaluateAcceptanceCommand {
  readonly type: "evaluate_acceptance";
  readonly nodeId: string;
  readonly attemptId: string;
}

export interface CancelAttemptCommand {
  readonly type: "cancel_attempt";
  readonly attemptId: string;
}

export interface CompleteRunCommand {
  readonly type: "complete_run";
  readonly status: RunCompletionStatus;
}

export type Command = DispatchCommand | EvaluateAcceptanceCommand | CancelAttemptCommand | CompleteRunCommand;
