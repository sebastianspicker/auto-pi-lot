import {
  MAX_SESSION_ERROR_MESSAGE_LENGTH,
  type SessionEvent,
  type SettledReason,
  type UsageSource,
} from "@auto-pi-lot/core/session";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/** The `messages` array on an `agent_end` event; one entry per role in the run's transcript. */
type AgentRunMessage = Extract<AgentSessionEvent, { type: "agent_end" }>["messages"][number];
type AssistantRunMessage = Extract<AgentRunMessage, { role: "assistant" }>;

/**
 * Structural subset of the SDK's `Usage` type. Declared locally (rather than imported)
 * because `Usage` lives in `@earendil-works/pi-ai`, a transitive dependency of the pinned
 * SDK that this package does not depend on directly; the SDK's own declared event types are
 * still the source of truth for field names.
 */
interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function isZeroUsage(usage: UsageLike): boolean {
  return usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0;
}

function mapUsage(usage: UsageLike | undefined, source: UsageSource): SessionEvent {
  if (usage === undefined) {
    return { type: "usage", qualification: "unknown", source };
  }
  return {
    type: "usage",
    qualification: "reported",
    source,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
  };
}

function lastAssistantMessage(messages: readonly AgentRunMessage[]): AssistantRunMessage | undefined {
  return [...messages].reverse().find((message): message is AssistantRunMessage => message.role === "assistant");
}

const FALLBACK_ERROR_MESSAGE = "Agent run ended in error";

function boundErrorMessage(message: string | undefined): string {
  const trimmed = message?.trim() ?? "";
  if (trimmed === "") return FALLBACK_ERROR_MESSAGE;
  return trimmed.length > MAX_SESSION_ERROR_MESSAGE_LENGTH
    ? trimmed.slice(0, MAX_SESSION_ERROR_MESSAGE_LENGTH).trim()
    : trimmed;
}

interface RunOutcome {
  reason: SettledReason;
  errorMessage?: string | undefined;
  willRetry: boolean;
}

function outcomeOfAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): RunOutcome {
  const assistant = lastAssistantMessage(event.messages);
  // No assistant turn completed this run, e.g. aborted before any model response.
  if (assistant === undefined || assistant.stopReason === "aborted") {
    return { reason: "aborted", willRetry: event.willRetry };
  }
  if (assistant.stopReason === "error") {
    return { reason: "error", errorMessage: assistant.errorMessage, willRetry: event.willRetry };
  }
  return { reason: "completed", willRetry: event.willRetry };
}

function mapAssistantUsage(message: AssistantRunMessage): SessionEvent {
  // The SDK synthesises a zero-usage message for a failed or aborted run; that is no measurement.
  if ((message.stopReason === "error" || message.stopReason === "aborted") && isZeroUsage(message.usage)) {
    return mapUsage(undefined, "turn");
  }
  return mapUsage(message.usage, "turn");
}

/**
 * Creates a stateful mapper from Pi SDK session events to provider-neutral session events.
 * `agent_end` can fire several times per prompt and may announce a retry that never happens
 * (abort during backoff), so `settled` and `error` are derived at `agent_settled`, which the SDK
 * emits exactly once per prompt, from the last `agent_end` seen. Use one mapper per subscriber.
 * Never throws, and ignores SDK event types this port doesn't surface.
 */
export function createPiEventMapper(): (event: AgentSessionEvent) => SessionEvent[] {
  let outcome: RunOutcome | undefined;

  return (event) => {
    switch (event.type) {
      case "message_end":
        if (event.message.role !== "assistant") return [];
        return [mapAssistantUsage(event.message)];
      case "compaction_end":
        // Compaction summaries are themselves LLM calls; usage is optional per the SDK's
        // own declared `CompactionResult` type when the summary run didn't report it.
        return [mapUsage(event.result?.usage, "compaction")];
      case "tool_execution_start":
        return [{ type: "tool_call", callId: event.toolCallId, toolName: event.toolName }];
      case "tool_execution_end":
        return [{ type: "tool_result", callId: event.toolCallId, isError: event.isError }];
      case "agent_end":
        outcome = outcomeOfAgentEnd(event);
        return [];
      case "agent_settled": {
        const recorded = outcome;
        outcome = undefined;
        // A recorded retry that never ran means the run was aborted during backoff.
        if (recorded === undefined || recorded.willRetry) return [{ type: "settled", reason: "aborted" }];
        if (recorded.reason === "error") {
          return [
            { type: "error", message: boundErrorMessage(recorded.errorMessage) },
            { type: "settled", reason: "error" },
          ];
        }
        return [{ type: "settled", reason: recorded.reason }];
      }
      default:
        return [];
    }
  };
}
