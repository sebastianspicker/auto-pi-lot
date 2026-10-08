import type {
  AttemptStatus,
  ExecutionState,
  FailureCategory,
  JournalEvent,
  ResultDisposition,
  RunState,
} from "@auto-pi-lot/core";

export interface NodeSummary {
  readonly execution: ExecutionState;
  readonly disposition: ResultDisposition | null;
  readonly attemptCount: number;
  readonly invalidatedAttemptCount: number;
  readonly failureCategory: FailureCategory | null;
}

/** One journal event with only its identifying fields; the full record is in the journal file. */
export interface EventSummary {
  readonly index: number;
  readonly type: JournalEvent["type"];
  readonly at: string;
  readonly nodeId?: string;
  readonly attemptId?: string;
  readonly fencingToken?: number;
  readonly category?: FailureCategory;
  readonly decision?: "accepted" | "rejected";
  readonly receiptIds?: readonly string[];
  readonly reason?: string;
}

export interface AttemptSummary {
  readonly nodeId: string;
  readonly fencingToken: number;
  readonly status: AttemptStatus;
  readonly consumes: Readonly<Record<string, string>>;
  readonly invalidated: boolean;
}

export function summarizeEvent(event: JournalEvent, index: number): EventSummary {
  const base = { index, type: event.type, at: event.at };
  switch (event.type) {
    case "run_started":
      return base;
    case "attempt_dispatched":
      return { ...base, nodeId: event.nodeId, attemptId: event.attemptId, fencingToken: event.fencingToken };
    case "result_proposed":
      return { ...base, attemptId: event.attemptId, fencingToken: event.fencingToken };
    case "acceptance_decided":
      return {
        ...base,
        nodeId: event.nodeId,
        attemptId: event.attemptId,
        decision: event.decision,
        receiptIds: event.receiptIds,
      };
    case "attempt_failed":
      return { ...base, attemptId: event.attemptId, fencingToken: event.fencingToken, category: event.category };
    case "lease_expired":
      return { ...base, attemptId: event.attemptId, fencingToken: event.fencingToken };
    case "cancel_requested":
      return { ...base, reason: event.reason };
    case "attempt_stopped":
      return { ...base, attemptId: event.attemptId };
  }
}

/** Built from entries so a node id such as `__proto__` becomes an own key, never a prototype write. */
export function summarizeNodes(state: RunState): Record<string, NodeSummary> {
  return Object.fromEntries(
    Object.entries(state.nodes).map(([nodeId, node]): [string, NodeSummary] => [
      nodeId,
      {
        execution: node.execution,
        disposition: node.disposition,
        attemptCount: node.attemptCount,
        invalidatedAttemptCount: node.invalidatedAttemptCount,
        failureCategory: node.failureCategory,
      },
    ]),
  );
}

export function summarizeAttempts(state: RunState): Record<string, AttemptSummary> {
  return Object.fromEntries(
    Object.entries(state.attempts).map(([attemptId, attempt]): [string, AttemptSummary] => [
      attemptId,
      {
        nodeId: attempt.nodeId,
        fencingToken: attempt.fencingToken,
        status: attempt.status,
        consumes: attempt.consumes,
        invalidated: attempt.invalidated,
      },
    ]),
  );
}

/** Attempt id -> node id for the evidence summary. */
export function attemptNodes(state: RunState): Record<string, string> {
  return Object.fromEntries(Object.entries(state.attempts).map(([attemptId, attempt]) => [attemptId, attempt.nodeId]));
}

/** An attempt id for a progress line: `sha256:` dropped, then the first 12 characters. */
export function shortAttemptId(attemptId: string): string {
  return (attemptId.startsWith("sha256:") ? attemptId.slice("sha256:".length) : attemptId).slice(0, 12);
}
