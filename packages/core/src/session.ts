import { z } from "zod";

const nonNegativeInteger = z.number().int().nonnegative();

/**
 * Token usage for one model call. `qualification` distinguishes a genuine provider
 * report from an unknown observation: per the budget state machine, unknown usage is
 * never reported as zero. `source` separates task turns from compaction summaries so
 * accounting can attribute each call.
 */
export const UsageSourceSchema = z.enum(["turn", "compaction"]);
export type UsageSource = z.infer<typeof UsageSourceSchema>;

export const UsageEventSchema = z.discriminatedUnion("qualification", [
  z.strictObject({
    type: z.literal("usage"),
    qualification: z.literal("reported"),
    source: UsageSourceSchema,
    inputTokens: nonNegativeInteger,
    outputTokens: nonNegativeInteger,
    cacheReadTokens: nonNegativeInteger.optional(),
    cacheWriteTokens: nonNegativeInteger.optional(),
  }),
  z.strictObject({
    type: z.literal("usage"),
    qualification: z.literal("unknown"),
    source: UsageSourceSchema,
  }),
]);
export type UsageEvent = z.infer<typeof UsageEventSchema>;

export const ToolCallEventSchema = z.strictObject({
  type: z.literal("tool_call"),
  callId: z.string().trim().min(1),
  toolName: z.string().trim().min(1),
});
export type ToolCallEvent = z.infer<typeof ToolCallEventSchema>;

export const ToolResultEventSchema = z.strictObject({
  type: z.literal("tool_result"),
  callId: z.string().trim().min(1),
  isError: z.boolean(),
});
export type ToolResultEvent = z.infer<typeof ToolResultEventSchema>;

export const SettledReasonSchema = z.enum(["completed", "aborted", "error"]);
export type SettledReason = z.infer<typeof SettledReasonSchema>;

export const SettledEventSchema = z.strictObject({
  type: z.literal("settled"),
  reason: SettledReasonSchema,
});
export type SettledEvent = z.infer<typeof SettledEventSchema>;

/** Bounds a provider error message; never a place for credentials or raw payloads. */
export const MAX_SESSION_ERROR_MESSAGE_LENGTH = 2000;

export const ErrorEventSchema = z.strictObject({
  type: z.literal("error"),
  message: z.string().trim().min(1).max(MAX_SESSION_ERROR_MESSAGE_LENGTH),
});
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;

/** Provider-neutral session event, mapped from an SDK's own event stream. */
export const SessionEventSchema = z.discriminatedUnion("type", [
  UsageEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  SettledEventSchema,
  ErrorEventSchema,
]);
export type SessionEvent = z.infer<typeof SessionEventSchema>;

/**
 * Provider-neutral coding session surface consumed by workers.
 *
 * A `settled` event reports that the underlying session stopped producing output; it is
 * not task acceptance. Acceptance requires evidence tied to the exact input artifacts and
 * code revision, never a worker's own completion report.
 */
export interface CodingSession {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  /** Registers a listener for mapped session events; returns an unsubscribe function. */
  subscribe(listener: (event: SessionEvent) => void): () => void;
}
