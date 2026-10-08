import { z } from "zod";

import { GraphSpecSchema } from "../graph/spec.js";
import { IdSchema, parseDto, SchemaVersionSchema, type ValidationIssue } from "../wire.js";
import { AcceptanceDecisionSchema } from "./evidence.js";
import { ExecutionManifestSchema, RunVerificationResultSchema } from "./execution.js";
import { FailureCategorySchema } from "./status.js";

const positiveInteger = z.number().int().positive();

/** Fields every journal event carries; `at` is the host's own timestamp, not model output. */
const journalEventBase = {
  schemaVersion: SchemaVersionSchema,
  eventId: IdSchema,
  runId: IdSchema,
  at: z.iso.datetime(),
};

export const RunPolicySchema = z.strictObject({
  maxConcurrent: positiveInteger,
  maxAttemptsPerNode: positiveInteger,
  /**
   * How many writer-role attempts (`isWriterRole`) may hold a permit at once. A host whose
   * workers share one workspace passes 1, so no writer starts until the current one has reported
   * (decision 0011). Omitted: writers are bounded by `maxConcurrent` alone. Optional on the wire
   * so earlier journals keep their digests.
   */
  maxConcurrentWriters: positiveInteger.optional(),
  /** Require a journaled final-tree verification before success. */
  requireFinalVerification: z.boolean().optional(),
});
export type RunPolicy = z.infer<typeof RunPolicySchema>;

/** The writer slots a policy grants: `maxConcurrentWriters`, or every permit when it is omitted. */
export function writerSlotsOf(policy: RunPolicy): number {
  return policy.maxConcurrentWriters ?? policy.maxConcurrent;
}

/** The host admitted a run: the graph it will execute and the policy bounding it. */
export const RunStartedEventSchema = z
  .strictObject({
    type: z.literal("run_started"),
    ...journalEventBase,
    graph: GraphSpecSchema,
    policy: RunPolicySchema,
    execution: ExecutionManifestSchema.optional(),
  })
  .superRefine((event, ctx) => {
    const execution = event.execution;
    if (execution?.worker !== "pi") return;
    const profiles = new Set(execution.checks.map((profile) => profile.id));
    const required = new Set(event.graph.nodes.flatMap((node) => node.checks ?? []));
    if (
      !event.policy.requireFinalVerification ||
      profiles.size !== execution.checks.length ||
      new Set(execution.finalCheckIds).size !== execution.finalCheckIds.length ||
      [...required].some((id) => !execution.finalCheckIds.includes(id)) ||
      execution.finalCheckIds.some((id) => !profiles.has(id))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Pi execution must pin every declared final check and require final verification",
      });
    }
  });
export type RunStartedEvent = z.infer<typeof RunStartedEventSchema>;

/**
 * The persisted dispatch intent for one attempt. The host records this event before the
 * effect (worker launch) runs, so recovery can tell a reserved attempt from one that never
 * left the host.
 */
export const AttemptDispatchedEventSchema = z.strictObject({
  type: z.literal("attempt_dispatched"),
  ...journalEventBase,
  nodeId: IdSchema,
  attemptId: IdSchema,
  fencingToken: positiveInteger,
});
export type AttemptDispatchedEvent = z.infer<typeof AttemptDispatchedEventSchema>;

/** A worker's own claim about its output; it cannot carry a host acceptance decision. */
export const ResultProposedEventSchema = z.strictObject({
  type: z.literal("result_proposed"),
  ...journalEventBase,
  attemptId: IdSchema,
  fencingToken: positiveInteger,
  proposalDigest: IdSchema,
});
export type ResultProposedEvent = z.infer<typeof ResultProposedEventSchema>;

/**
 * The host's own acceptance gate outcome. AP-12 will produce this event from check/review
 * receipts; here it is an input the reducer consumes, not something it computes.
 */
export const AcceptanceDecidedEventSchema = z
  .strictObject({
    type: z.literal("acceptance_decided"),
    ...journalEventBase,
    nodeId: IdSchema,
    attemptId: IdSchema,
    decision: AcceptanceDecisionSchema,
    receiptIds: z.array(IdSchema).max(64),
  })
  .superRefine((event, ctx) => {
    if (event.decision === "accepted" && event.receiptIds.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["receiptIds"],
        message: "An accepted decision requires at least one receipt",
      });
    }
  });
export type AcceptanceDecidedEvent = z.infer<typeof AcceptanceDecidedEventSchema>;

export const AttemptFailedEventSchema = z.strictObject({
  type: z.literal("attempt_failed"),
  ...journalEventBase,
  attemptId: IdSchema,
  fencingToken: positiveInteger,
  category: FailureCategorySchema,
});
export type AttemptFailedEvent = z.infer<typeof AttemptFailedEventSchema>;

export const LeaseExpiredEventSchema = z.strictObject({
  type: z.literal("lease_expired"),
  ...journalEventBase,
  attemptId: IdSchema,
  fencingToken: positiveInteger,
});
export type LeaseExpiredEvent = z.infer<typeof LeaseExpiredEventSchema>;

export const CancelRequestedEventSchema = z.strictObject({
  type: z.literal("cancel_requested"),
  ...journalEventBase,
  reason: z.string().trim().min(1).max(2000),
});
export type CancelRequestedEvent = z.infer<typeof CancelRequestedEventSchema>;

/** A worker confirmed it stopped after `cancel_requested`; releases the attempt's permit. */
export const AttemptStoppedEventSchema = z.strictObject({
  type: z.literal("attempt_stopped"),
  ...journalEventBase,
  attemptId: IdSchema,
});
export type AttemptStoppedEvent = z.infer<typeof AttemptStoppedEventSchema>;

export const RunVerifiedEventSchema = z.strictObject({
  type: z.literal("run_verified"),
  ...journalEventBase,
  result: RunVerificationResultSchema,
});
export type RunVerifiedEvent = z.infer<typeof RunVerifiedEventSchema>;

export const JournalEventSchema = z.discriminatedUnion("type", [
  RunStartedEventSchema,
  AttemptDispatchedEventSchema,
  ResultProposedEventSchema,
  AcceptanceDecidedEventSchema,
  AttemptFailedEventSchema,
  LeaseExpiredEventSchema,
  CancelRequestedEventSchema,
  AttemptStoppedEventSchema,
  RunVerifiedEventSchema,
]);
export type JournalEvent = z.infer<typeof JournalEventSchema>;

/** Strict parsing that never throws; the reducer only ever sees a validated `JournalEvent`. */
export function parseJournalEvent(
  input: unknown,
): { ok: true; value: JournalEvent } | { ok: false; issues: ValidationIssue[] } {
  return parseDto(JournalEventSchema, input);
}
