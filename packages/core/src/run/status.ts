import { z } from "zod";

import type { DependencyCondition } from "../graph/spec.js";

/** Execution progress of a node's current attempt; independent of result trust. */
export const ExecutionStateSchema = z.enum([
  "pending",
  "ready",
  "running",
  "waiting_children",
  "waiting_input",
  "waiting_approval",
  "result_ready",
  "failed",
  "cancelled",
  "exhausted",
]);
export type ExecutionState = z.infer<typeof ExecutionStateSchema>;

/** Host trust in a produced result; separate from whether execution finished. */
export const ResultDispositionSchema = z.enum(["unverified", "verifying", "accepted", "rejected", "invalidated"]);
export type ResultDisposition = z.infer<typeof ResultDispositionSchema>;

export const FailureCategorySchema = z.enum([
  "schema_invalid",
  "semantic_invalid",
  "check_failed",
  "review_rejected",
  "budget_exhausted",
  "deadline_exceeded",
  "cancelled",
  "worker_crashed",
  "lease_lost",
  "policy_denied",
  "effect_uncertain",
  "dependency_failed",
]);
export type FailureCategory = z.infer<typeof FailureCategorySchema>;

/**
 * A producer node's execution and disposition, as seen by dependency readiness: the one shape
 * shared by `isDependencySatisfied`, `getReadyNodes`, and the reducer's own node state, instead
 * of each defining its own equivalent structural type.
 */
export interface NodeStatus {
  readonly execution: ExecutionState;
  readonly disposition?: ResultDisposition;
}

/**
 * Pure dependency readiness rule shared by the reducer and readiness calculation:
 * `accepted` requires host acceptance; `result_ready` only requires a produced,
 * not-yet-rejected result.
 */
export function isDependencySatisfied(condition: DependencyCondition, producer: NodeStatus): boolean {
  if (condition === "accepted") {
    return producer.disposition === "accepted";
  }
  return (
    producer.execution === "result_ready" &&
    (producer.disposition === "unverified" ||
      producer.disposition === "verifying" ||
      producer.disposition === "accepted")
  );
}
