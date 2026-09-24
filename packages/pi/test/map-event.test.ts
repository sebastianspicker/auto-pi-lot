import assert from "node:assert/strict";
import test from "node:test";

import { MAX_SESSION_ERROR_MESSAGE_LENGTH, SessionEventSchema } from "@auto-pi-lot/core/session";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { mapPiEvent } from "../src/map-event.js";

type AssistantRunMessage = Extract<
  Extract<AgentSessionEvent, { type: "agent_end" }>["messages"][number],
  { role: "assistant" }
>;

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function assistantMessage(overrides: Partial<AssistantRunMessage>): AssistantRunMessage {
  return {
    role: "assistant",
    content: [],
    api: "messages",
    provider: "anthropic",
    model: "claude-test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: zeroCost },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

function assertAllParse(events: unknown[]): void {
  for (const event of events) SessionEventSchema.parse(event);
}

test("message_end for an assistant message maps reported usage", () => {
  const event: AgentSessionEvent = {
    type: "message_end",
    message: assistantMessage({
      usage: { input: 120, output: 40, cacheRead: 10, cacheWrite: 5, totalTokens: 175, cost: zeroCost },
    }),
  };
  const mapped = mapPiEvent(event);
  assert.deepEqual(mapped, [
    {
      type: "usage",
      qualification: "reported",
      source: "turn",
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    },
  ]);
  assertAllParse(mapped);
});

test("message_end for a non-assistant message maps to nothing", () => {
  const event: AgentSessionEvent = {
    type: "message_end",
    message: { role: "user", content: "hi", timestamp: 0 },
  };
  assert.deepEqual(mapPiEvent(event), []);
});

test("compaction_end without a result maps unknown usage", () => {
  const event: AgentSessionEvent = {
    type: "compaction_end",
    reason: "threshold",
    result: undefined,
    aborted: false,
    willRetry: false,
  };
  const mapped = mapPiEvent(event);
  assert.deepEqual(mapped, [{ type: "usage", qualification: "unknown", source: "compaction" }]);
  assertAllParse(mapped);
});

test("compaction_end with a result but no usage maps unknown usage", () => {
  const event: AgentSessionEvent = {
    type: "compaction_end",
    reason: "manual",
    result: { summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 1000 },
    aborted: false,
    willRetry: false,
  };
  const mapped = mapPiEvent(event);
  assert.deepEqual(mapped, [{ type: "usage", qualification: "unknown", source: "compaction" }]);
  assertAllParse(mapped);
});

test("compaction_end with reported usage maps reported usage", () => {
  const event: AgentSessionEvent = {
    type: "compaction_end",
    reason: "manual",
    result: {
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 1000,
      usage: { input: 50, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 70, cost: zeroCost },
    },
    aborted: false,
    willRetry: false,
  };
  const mapped = mapPiEvent(event);
  assert.deepEqual(mapped, [
    {
      type: "usage",
      qualification: "reported",
      source: "compaction",
      inputTokens: 50,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  ]);
  assertAllParse(mapped);
});

test("tool_execution_start maps to tool_call", () => {
  const event: AgentSessionEvent = {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "read",
    args: { path: "README.md" },
  };
  const mapped = mapPiEvent(event);
  assert.deepEqual(mapped, [{ type: "tool_call", callId: "call-1", toolName: "read" }]);
  assertAllParse(mapped);
});

test("tool_execution_end maps to tool_result", () => {
  const event: AgentSessionEvent = {
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "read",
    result: { content: [] },
    isError: true,
  };
  const mapped = mapPiEvent(event);
  assert.deepEqual(mapped, [{ type: "tool_result", callId: "call-1", isError: true }]);
  assertAllParse(mapped);
});

test("agent_end with a normal stop reason maps to settled completed", () => {
  const event: AgentSessionEvent = {
    type: "agent_end",
    messages: [assistantMessage({ stopReason: "stop" })],
    willRetry: false,
  };
  const mapped = mapPiEvent(event);
  assert.deepEqual(mapped, [{ type: "settled", reason: "completed" }]);
  assertAllParse(mapped);
});

test("agent_end with an aborted assistant message maps to settled aborted", () => {
  const event: AgentSessionEvent = {
    type: "agent_end",
    messages: [assistantMessage({ stopReason: "aborted" })],
    willRetry: false,
  };
  const mapped = mapPiEvent(event);
  assert.deepEqual(mapped, [{ type: "settled", reason: "aborted" }]);
  assertAllParse(mapped);
});

test("agent_end with no assistant message maps to settled aborted", () => {
  const event: AgentSessionEvent = {
    type: "agent_end",
    messages: [{ role: "user", content: "hi", timestamp: 0 }],
    willRetry: false,
  };
  const mapped = mapPiEvent(event);
  assert.deepEqual(mapped, [{ type: "settled", reason: "aborted" }]);
  assertAllParse(mapped);
});

test("agent_end with an error assistant message maps to error then settled error", () => {
  const event: AgentSessionEvent = {
    type: "agent_end",
    messages: [assistantMessage({ stopReason: "error", errorMessage: "the provider rejected the request" })],
    willRetry: false,
  };
  const mapped = mapPiEvent(event);
  assert.deepEqual(mapped, [
    { type: "error", message: "the provider rejected the request" },
    { type: "settled", reason: "error" },
  ]);
  assertAllParse(mapped);
});

test("agent_end error message is bounded to the schema's maximum length", () => {
  const longMessage = "x".repeat(MAX_SESSION_ERROR_MESSAGE_LENGTH + 500);
  const event: AgentSessionEvent = {
    type: "agent_end",
    messages: [assistantMessage({ stopReason: "error", errorMessage: longMessage })],
    willRetry: false,
  };
  const mapped = mapPiEvent(event);
  const [errorEvent] = mapped;
  assert.equal(errorEvent?.type, "error");
  assert.equal(
    errorEvent && "message" in errorEvent ? errorEvent.message.length : -1,
    MAX_SESSION_ERROR_MESSAGE_LENGTH,
  );
  assertAllParse(mapped);
});

test("agent_end that will retry has not settled yet", () => {
  const event: AgentSessionEvent = {
    type: "agent_end",
    messages: [assistantMessage({ stopReason: "error", errorMessage: "transient" })],
    willRetry: true,
  };
  assert.deepEqual(mapPiEvent(event), []);
});

test("an unhandled SDK event maps to nothing", () => {
  const event: AgentSessionEvent = { type: "queue_update", steering: [], followUp: [] };
  assert.deepEqual(mapPiEvent(event), []);
});
