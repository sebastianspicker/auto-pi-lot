import { z } from "zod";

import { digest } from "../canonical.js";
import { IdSchema, SchemaVersionSchema } from "../wire.js";

/**
 * These are the records that a journal `result_proposed` event's `proposalDigest` and an
 * `acceptance_decided` event's `receiptIds` refer to: a worker's own proposal, the
 * deterministic checks and independent reviews it may cite, and the host's own acceptance
 * decision over them.
 */

const positiveInteger = z.number().int().positive();

/**
 * A worker's claim about its own output. Deliberately has no `status`/`accepted` field:
 * a proposal cannot self-accept. Only `AcceptanceRecord` records the host decision.
 */
export const ResultProposalSchema = z
  .strictObject({
    kind: z.literal("proposal"),
    schemaVersion: SchemaVersionSchema,
    id: IdSchema,
    runId: IdSchema,
    graphId: IdSchema,
    graphRevision: positiveInteger,
    nodeId: IdSchema,
    attemptId: IdSchema,
    summary: z.string().trim().min(1),
    /** Artifacts the attempt produced; for a checker, its review receipt. */
    outputArtifactIds: z.array(IdSchema).max(64),
    claims: z.array(z.string().trim().min(1)),
    limitations: z.array(z.string().trim().min(1)),
    requestedChecks: z.array(IdSchema),
    /**
     * The check receipts the host-side worker recorded for this attempt. The gate counts only
     * these (decision 0010): a receipt that no journal-anchored proposal names is not evidence,
     * however well-formed, so a model that can write files cannot plant one.
     */
    checkReceiptIds: z.array(IdSchema).max(64),
    inputFingerprint: IdSchema,
    baseRevision: IdSchema.optional(),
    resultRevision: IdSchema.optional(),
  })
  .superRefine((proposal, context) => {
    if (proposal.baseRevision !== undefined && proposal.resultRevision === undefined) {
      context.addIssue({
        code: "custom",
        path: ["resultRevision"],
        message: "A proposal with a base revision requires a result revision",
      });
    }
  });
export type ResultProposal = z.infer<typeof ResultProposalSchema>;

export const CheckOutcomeSchema = z.enum(["pass", "fail", "error", "timeout"]);
export type CheckOutcome = z.infer<typeof CheckOutcomeSchema>;

export const TestCountSchema = z.strictObject({
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type TestCount = z.infer<typeof TestCountSchema>;

/** A deterministic check execution; distinguishable from model judgment. */
export const CheckReceiptSchema = z.strictObject({
  kind: z.literal("check"),
  schemaVersion: SchemaVersionSchema,
  id: IdSchema,
  runId: IdSchema,
  /** The attempt whose workspace state this check ran against. */
  attemptId: IdSchema,
  profileId: IdSchema,
  profileVersion: IdSchema,
  executable: z.string().trim().min(1),
  args: z.array(z.string()),
  environmentDigest: IdSchema,
  inputDigest: IdSchema,
  sourceDigest: IdSchema,
  exitCode: z.union([z.number().int(), z.null()]),
  outcome: CheckOutcomeSchema,
  testCount: TestCountSchema.optional(),
  logArtifactIds: z.array(IdSchema),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
});
export type CheckReceipt = z.infer<typeof CheckReceiptSchema>;

export const ReviewVerdictSchema = z.enum(["pass", "fail", "unclear"]);
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export const ReviewCriterionVerdictSchema = z.strictObject({
  criterion: z.string().trim().min(1).max(2000),
  verdict: ReviewVerdictSchema,
  evidenceIds: z.array(IdSchema).max(64),
  /** The reviewer's own words about this criterion; data, not a decision. */
  note: z.string().trim().min(1).max(2000).optional(),
});
export type ReviewCriterionVerdict = z.infer<typeof ReviewCriterionVerdictSchema>;

/** Independent criterion assessment; model judgment stays distinguishable from checks. */
export const ReviewReceiptSchema = z.strictObject({
  kind: z.literal("review"),
  schemaVersion: SchemaVersionSchema,
  id: IdSchema,
  runId: IdSchema,
  /** The proposal digest of the producer result the reviewer looked at. */
  candidateDigest: IdSchema,
  /** The producer attempt that proposed the candidate. */
  candidateAttemptId: IdSchema,
  reviewerAttemptId: IdSchema,
  verdicts: z.array(ReviewCriterionVerdictSchema).min(1),
  limitations: z.array(z.string().trim().min(1)),
});
export type ReviewReceipt = z.infer<typeof ReviewReceiptSchema>;

export const AcceptanceDecisionSchema = z.enum(["accepted", "rejected"]);
export type AcceptanceDecision = z.infer<typeof AcceptanceDecisionSchema>;

export const InvalidationSchema = z.strictObject({
  reason: z.string().trim().min(1),
  at: z.iso.datetime(),
});
export type Invalidation = z.infer<typeof InvalidationSchema>;

/** The host's own decision, tied to the exact candidate/input and required receipts. */
export const AcceptanceRecordSchema = z
  .strictObject({
    kind: z.literal("acceptance"),
    schemaVersion: SchemaVersionSchema,
    id: IdSchema,
    runId: IdSchema,
    graphId: IdSchema,
    graphRevision: positiveInteger,
    nodeId: IdSchema,
    attemptId: IdSchema,
    proposalDigest: IdSchema,
    inputFingerprint: IdSchema,
    decision: AcceptanceDecisionSchema,
    checkReceiptIds: z.array(IdSchema),
    reviewReceiptIds: z.array(IdSchema),
    policyRevision: positiveInteger,
    decidedAt: z.iso.datetime(),
    /** The gate's explanation, for operators. */
    reasons: z.array(z.string().trim().min(1).max(2000)).max(32).optional(),
    invalidation: InvalidationSchema.optional(),
  })
  .superRefine((record, context) => {
    if (record.decision === "accepted" && record.checkReceiptIds.length === 0 && record.reviewReceiptIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["decision"],
        message: "Accepted results require at least one check or review receipt",
      });
    }
  });
export type AcceptanceRecord = z.infer<typeof AcceptanceRecordSchema>;

/** Every record an evidence store holds, told apart by `kind`. */
export const EvidenceRecordSchema = z.discriminatedUnion("kind", [
  ResultProposalSchema,
  CheckReceiptSchema,
  ReviewReceiptSchema,
  AcceptanceRecordSchema,
]);
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
export type EvidenceKind = EvidenceRecord["kind"];

/**
 * An evidence record's identity is the digest of its content without the `id` field, so the
 * same record always gets the same id and a record cannot be altered without changing its id.
 * Returns the record with `id` filled in. A `result_proposed` event's `proposalDigest` is the
 * id of the proposal record.
 */
export function identifyEvidence<T extends { readonly id: string }>(record: Omit<T, "id">): T {
  const { id: _ignored, ...content } = record as Omit<T, "id"> & { id?: unknown };
  return { ...(content as object), id: digest(content) } as T;
}
