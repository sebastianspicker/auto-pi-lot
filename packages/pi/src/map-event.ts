import { MAX_SESSION_ERROR_MESSAGE_LENGTH, type SessionEvent, type UsageSource } from "@auto-pi-lot/core/session";
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

function boundErrorMessage(message: string): string {
  return message.length > MAX_SESSION_ERROR_MESSAGE_LENGTH
    ? message.slice(0, MAX_SESSION_ERROR_MESSAGE_LENGTH)
    : message;
}

function mapAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): SessionEvent[] {
  // A retryable failure keeps the run going internally; it has not settled yet.
  if (event.willRetry) return [];

  const assistant = lastAssistantMessage(event.messages);
  if (assistant === undefined) {
    // No assistant turn completed this run, e.g. aborted before any model response.
    return [{ type: "settled", reason: "aborted" }];
  }
  if (assistant.stopReason === "aborted") {
    return [{ type: "settled", reason: "aborted" }];
  }
  if (assistant.stopReason === "error") {
    const message = boundErrorMessage(assistant.errorMessage ?? "Agent run ended in error");
    return [
      { type: "error", message },
      { type: "settled", reason: "error" },
    ];
  }
  return [{ type: "settled", reason: "completed" }];
}

/**
 * Maps one Pi SDK session event to zero or more provider-neutral session events.
 * Pure and total: never throws, and ignores SDK event types this port doesn't surface.
 */
export function mapPiEvent(event: AgentSessionEvent): SessionEvent[] {
  switch (event.type) {
    case "message_end":
      if (event.message.role !== "assistant") return [];
      return [mapUsage(event.message.usage, "turn")];
    case "compaction_end":
      // Compaction summaries are themselves LLM calls; usage is optional per the SDK's
      // own declared `CompactionResult` type when the summary run didn't report it.
      return [mapUsage(event.result?.usage, "compaction")];
    case "tool_execution_start":
      return [{ type: "tool_call", callId: event.toolCallId, toolName: event.toolName }];
    case "tool_execution_end":
      return [{ type: "tool_result", callId: event.toolCallId, isError: event.isError }];
    case "agent_end":
      return mapAgentEnd(event);
    default:
      return [];
  }
}
