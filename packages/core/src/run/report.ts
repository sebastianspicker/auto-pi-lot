import { z } from "zod";

import { ReviewVerdictSchema } from "./evidence.js";

/**
 * What a worker's final message must contain, as the model writes it: one fenced ```json block.
 * These are the only two shapes the session worker accepts; anything else is a malformed
 * report, which costs the attempt (`schema_invalid`). Both are bounded so a runaway reply cannot
 * grow a record without limit. Neither can carry an acceptance: the host decides that.
 */
/** Longest text a report field may hold, a review's verbatim criterion included. */
export const MAX_REPORT_TEXT = 2000;
/** Most verdicts one review may give: one per acceptance criterion of the candidate's producer. */
export const MAX_REVIEW_VERDICTS = 64;

const shortText = z.string().trim().min(1).max(MAX_REPORT_TEXT);

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
    .max(MAX_REVIEW_VERDICTS),
  limitations: z.array(shortText).max(32),
});
export type ReviewReport = z.infer<typeof ReviewReportSchema>;

/**
 * The producer's acceptance criteria that `review` has no verdict for (exact text after
 * trimming). The worker uses it on a report and the gate on a stored receipt, so both apply
 * the same rule (decision 0010, item 4).
 */
export function criteriaMissing(
  criteria: readonly string[],
  review: { readonly verdicts: readonly { readonly criterion: string }[] },
): string[] {
  const judged = new Set(review.verdicts.map((verdict) => verdict.criterion.trim()));
  return criteria.map((criterion) => criterion.trim()).filter((criterion) => !judged.has(criterion));
}

/**
 * Finds the last fenced ```json block in a message and returns its parsed value, or `null` when
 * there is none or it is not JSON. Pure; never throws. The caller validates the value against
 * `WorkReportSchema` or `ReviewReportSchema`.
 */
export function extractJsonBlock(text: string): unknown {
  let cursor = 0;
  let last: string | null = null;
  while (cursor < text.length) {
    const marker = text.indexOf("```json", cursor);
    if (marker === -1) break;
    let start = marker + 7;
    let newline = -1;
    let previousNewline = -1;
    while (start < text.length && reportWhitespace(text[start])) {
      if (text[start] === "\n") {
        previousNewline = newline;
        newline = start;
      }
      start++;
    }
    if (newline === -1) {
      cursor = start;
      continue;
    }
    const bodyStart = newline + 1;
    const closing = closingJsonFence(text, bodyStart);
    if (closing === undefined) {
      // The old greedy opener can fall back to an earlier blank line for an empty block.
      if (previousNewline !== -1 && text.startsWith("```", start)) return null;
      break;
    }
    last = text.slice(bodyStart, closing.bodyEnd);
    cursor = closing.fenceEnd;
  }
  if (last === null) return null;
  try {
    return JSON.parse(last) as unknown;
  } catch {
    return null;
  }
}

/** Each fence and its immediately preceding whitespace is visited at most once. */
function closingJsonFence(text: string, bodyStart: number): { bodyEnd: number; fenceEnd: number } | undefined {
  let fence = text.indexOf("```", bodyStart);
  while (fence !== -1) {
    let whitespaceStart = fence;
    let newline = -1;
    while (whitespaceStart > bodyStart && reportWhitespace(text[whitespaceStart - 1])) {
      whitespaceStart--;
      if (text[whitespaceStart] === "\n") newline = whitespaceStart;
    }
    if (newline !== -1) return { bodyEnd: newline, fenceEnd: fence + 3 };
    fence = text.indexOf("```", fence + 3);
  }
  return undefined;
}

function reportWhitespace(character: string | undefined): boolean {
  return character !== undefined && character.trim() === "";
}
