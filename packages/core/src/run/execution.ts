import { z } from "zod";
import { IdSchema } from "../wire.js";

const positiveInteger = z.number().int().positive();

/** Longest a single check may run before the runner kills its process group. */
export const MAX_CHECK_TIMEOUT_MS = 3_600_000;
export const DEFAULT_CHECK_TIMEOUT_MS = 600_000;

/**
 * A deterministic check the host runs itself, never through a model: one executable and an
 * argument list (no shell), in the workspace or a directory inside it, under a timeout. A node
 * names the profiles it must pass in `NodeSpec.checks`. The profile is data an operator wrote;
 * the worker cannot add or alter one.
 */
export const CheckProfileSchema = z.strictObject({
  id: IdSchema,
  /** Human-readable purpose, shown in reports. */
  description: z.string().trim().min(1).max(500).optional(),
  command: z.string().trim().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(256),
  /** Working directory relative to the workspace root; must stay inside it. Default: the root. */
  cwd: z.string().trim().min(1).max(1024).optional(),
  timeoutMs: positiveInteger.max(MAX_CHECK_TIMEOUT_MS).optional(),
});
export type CheckProfile = z.infer<typeof CheckProfileSchema>;

/** A pinned model route for the real worker: provider and model id as the SDK's registry names them. */
export const ModelRouteSchema = z.strictObject({
  provider: z.string().trim().min(1).max(128),
  id: z.string().trim().min(1).max(256),
});
export type ModelRoute = z.infer<typeof ModelRouteSchema>;

export const ThinkingLevelSchema = z.enum(["off", "low", "medium", "high"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

/** Immutable execution recipe carried by run_started; no credentials or environment values. */
export const ExecutionManifestSchema = z.discriminatedUnion("worker", [
  z.strictObject({ worker: z.literal("fake"), workspace: z.string().min(1) }),
  z.strictObject({
    worker: z.literal("pi"),
    workspace: z.string().min(1),
    checks: z.array(CheckProfileSchema).max(64),
    model: ModelRouteSchema,
    thinkingLevel: ThinkingLevelSchema,
    finalCheckIds: z.array(IdSchema).max(64),
  }),
]);
export type ExecutionManifest = z.infer<typeof ExecutionManifestSchema>;

/** Final-tree evidence, journaled before a run can succeed. Empty profiles means no deterministic coverage. */
export const RunVerificationResultSchema = z
  .strictObject({
    outcome: z.enum(["passed", "failed", "cancelled"]),
    sourceDigest: IdSchema.optional(),
    checkProfileIds: z.array(IdSchema).max(64),
    checkReceiptIds: z.array(IdSchema).max(64),
    reasons: z.array(z.string().min(1).max(2000)).max(66),
  })
  .superRefine((result, ctx) => {
    if (
      new Set(result.checkProfileIds).size !== result.checkProfileIds.length ||
      new Set(result.checkReceiptIds).size !== result.checkReceiptIds.length
    ) {
      ctx.addIssue({ code: "custom", message: "Final check profiles and receipts must be unique" });
    }
    if (
      result.outcome === "passed" &&
      (result.sourceDigest === undefined ||
        result.reasons.length > 0 ||
        result.checkProfileIds.length !== result.checkReceiptIds.length)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Passing final verification requires one receipt per check and no failure reasons",
      });
    }
  });
export type RunVerificationResult = z.infer<typeof RunVerificationResultSchema>;
