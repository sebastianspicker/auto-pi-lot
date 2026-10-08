import { z } from "zod";

import { ReviewVerdictSchema } from "./evidence.js";

/**
 * What a worker's final message must contain, as the model writes it: one fenced ```json block.
 * These are the only two shapes the session worker accepts; anything else is a malformed
 * report, which costs the attempt (`schema_invalid`). Both are bounded so a runaway reply cannot
 * grow a record without limit. Neither can carry an acceptance: the host decides that.
 */
const shortText = z.string().trim().min(1).max(2000);

/** A producer's (planner, explorer, implementer, integrator) report about its own work. */
export const WorkReportSchema = z.strictObject({
  summary: shortText,
  claims: z.array(shortText).max(32),
  limitations: z.array(shortText).max(32),
});
export type WorkReport = z.infer<typeof WorkReportSchema>;

/** A checker's (verifier, falsifier, reviewer) verdict per acceptance criterion of the producer. */
export const ReviewReportSchema = z.strictObject({
  verdicts: z
    .array(
      z.strictObject({
        criterion: shortText,
        verdict: ReviewVerdictSchema,
        evidence: shortText,
      }),
    )
    .min(1)
    .max(64),
  limitations: z.array(shortText).max(32),
});
export type ReviewReport = z.infer<typeof ReviewReportSchema>;

/**
 * Finds the last fenced ```json block in a message and returns its parsed value, or `null` when
 * there is none or it is not JSON. Pure; never throws. The caller validates the value against
 * `WorkReportSchema` or `ReviewReportSchema`.
 */
export function extractJsonBlock(text: string): unknown {
  const pattern = /```json\s*\n([\s\S]*?)\n\s*```/g;
  let last: string | null = null;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    last = match[1] ?? null;
  }
  if (last === null) return null;
  try {
    return JSON.parse(last) as unknown;
  } catch {
    return null;
  }
}
