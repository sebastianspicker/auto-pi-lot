import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_ASSISTANT_TEXT_LENGTH,
  MAX_SESSION_ERROR_MESSAGE_LENGTH,
  SessionEventSchema,
} from "@auto-pi-lot/core/session";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { createPiEventMapper } from "../src/map-event.js";

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
  const mapped = createPiEventMapper()(event);
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
    { type: "assistant_message", text: "", truncated: false },
  ]);
  assertAllParse(mapped);
});

test("message_end for an assistant message carries its text parts, joined, bounded and flagged", () => {
  const short = createPiEventMapper()({
    type: "message_end",
    message: assistantMessage({
      content: [
        { type: "text", text: "First" },
        { type: "thinking", thinking: "private", thinkingSignature: "" },
        { type: "toolCall", id: "c1", name: "read", arguments: {} },
        { type: "text", text: "Second" },
      ],
    }),
  });
  assert.deepEqual(short[1], { type: "assistant_message", text: "First\n\nSecond", truncated: false });
  const long = createPiEventMapper()({
    type: "message_end",
    message: assistantMessage({
      content: [{ type: "text", text: `HEAD${"x".repeat(MAX_ASSISTANT_TEXT_LENGTH)}TAIL-REPORT` }],
    }),
  });
  const text = long[1];
  assert.ok(text?.type === "assistant_message" && text.truncated && text.text.length === MAX_ASSISTANT_TEXT_LENGTH);
  // The report block sits at the end of a message: the tail survives, the head is dropped.
  assert.ok(text.text.endsWith("TAIL-REPORT"));
  assert.ok(!text.text.includes("HEAD"));
  assertAllParse(short);
  assertAllParse(long);
});

test("message_end for a non-assistant message maps to nothing", () => {
  const event: AgentSessionEvent = {
    type: "message_end",
    message: { role: "user", content: "hi", timestamp: 0 },
  };
  assert.deepEqual(createPiEventMapper()(event), []);
});

test("compaction_end without a result maps unknown usage", () => {
  const event: AgentSessionEvent = {
    type: "compaction_end",
    reason: "threshold",
    result: undefined,
    aborted: false,
    willRetry: false,
  };
  const mapped = createPiEventMapper()(event);
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
  const mapped = createPiEventMapper()(event);
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
  const mapped = createPiEventMapper()(event);
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
  const mapped = createPiEventMapper()(event);
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
  const mapped = createPiEventMapper()(event);
  assert.deepEqual(mapped, [{ type: "tool_result", callId: "call-1", isError: true }]);
  assertAllParse(mapped);
});

function agentEnd(
  overrides: Partial<AssistantRunMessage>,
  willRetry = false,
): Extract<AgentSessionEvent, { type: "agent_end" }> {
  return { type: "agent_end", messages: [assistantMessage(overrides)], willRetry };
}

const settledEvent: AgentSessionEvent = { type: "agent_settled" };

/** Feeds events to one mapper and returns everything it emitted, validated against the schema. */
function run(events: AgentSessionEvent[]) {
  const map = createPiEventMapper();
  const mapped = events.flatMap((event) => map(event));
  assertAllParse(mapped);
  return mapped;
}

test("agent_end alone emits nothing", () => {
  assert.deepEqual(run([agentEnd({ stopReason: "stop" })]), []);
  assert.deepEqual(run([agentEnd({ stopReason: "error", errorMessage: "boom" })]), []);
});

test("agent_settled after a completed agent_end maps to settled completed", () => {
  assert.deepEqual(run([agentEnd({ stopReason: "stop" }), settledEvent]), [{ type: "settled", reason: "completed" }]);
});

test("agent_settled after an aborted assistant message maps to settled aborted", () => {
  assert.deepEqual(run([agentEnd({ stopReason: "aborted" }), settledEvent]), [{ type: "settled", reason: "aborted" }]);
});

test("agent_settled after an agent_end without assistant message maps to settled aborted", () => {
  const end: AgentSessionEvent = {
    type: "agent_end",
    messages: [{ role: "user", content: "hi", timestamp: 0 }],
    willRetry: false,
  };
  assert.deepEqual(run([end, settledEvent]), [{ type: "settled", reason: "aborted" }]);
});

test("agent_settled after an error agent_end maps to error then settled error", () => {
  assert.deepEqual(
    run([agentEnd({ stopReason: "error", errorMessage: "the provider rejected the request" }), settledEvent]),
    [
      { type: "error", message: "the provider rejected the request" },
      { type: "settled", reason: "error" },
    ],
  );
});

test("agent_settled after a retrying agent_end maps to settled aborted only", () => {
  assert.deepEqual(run([agentEnd({ stopReason: "error", errorMessage: "transient" }, true), settledEvent]), [
    { type: "settled", reason: "aborted" },
  ]);
});

test("agent_settled with no prior agent_end maps to settled aborted", () => {
  assert.deepEqual(run([settledEvent]), [{ type: "settled", reason: "aborted" }]);
});

test("several agent_end events before one agent_settled derive from the last", () => {
  const mapped = run([
    agentEnd({ stopReason: "error", errorMessage: "first" }),
    agentEnd({ stopReason: "stop" }),
    settledEvent,
  ]);
  assert.deepEqual(mapped, [{ type: "settled", reason: "completed" }]);
});

test("the mapper resets between prompts", () => {
  const mapped = run([
    agentEnd({ stopReason: "error", errorMessage: "first prompt failed" }),
    settledEvent,
    agentEnd({ stopReason: "stop" }),
    settledEvent,
    settledEvent,
  ]);
  assert.deepEqual(mapped, [
    { type: "error", message: "first prompt failed" },
    { type: "settled", reason: "error" },
    { type: "settled", reason: "completed" },
    { type: "settled", reason: "aborted" },
  ]);
});

test("a blank errorMessage falls back to a fixed message", () => {
  for (const errorMessage of ["", "   \n"]) {
    const mapped = run([agentEnd({ stopReason: "error", errorMessage }), settledEvent]);
    assert.deepEqual(mapped[0], { type: "error", message: "Agent run ended in error" });
  }
});

test("the error message is trimmed and bounded to the schema's maximum length", () => {
  const longMessage = `  ${"x".repeat(MAX_SESSION_ERROR_MESSAGE_LENGTH + 500)}  `;
  const [errorEvent] = run([agentEnd({ stopReason: "error", errorMessage: longMessage }), settledEvent]);
  assert.equal(errorEvent?.type, "error");
  assert.equal(
    errorEvent && "message" in errorEvent ? errorEvent.message.length : -1,
    MAX_SESSION_ERROR_MESSAGE_LENGTH,
  );
});

test("zero usage on a synthetic error or aborted message maps to unknown", () => {
  for (const stopReason of ["error", "aborted"] as const) {
    const mapped = createPiEventMapper()({ type: "message_end", message: assistantMessage({ stopReason }) });
    assert.deepEqual(mapped, [
      { type: "usage", qualification: "unknown", source: "turn" },
      { type: "assistant_message", text: "", truncated: false },
    ]);
    assertAllParse(mapped);
  }
});

test("non-zero usage on an error message and zero usage on a normal stop stay reported", () => {
  const partial = createPiEventMapper()({
    type: "message_end",
    message: assistantMessage({
      stopReason: "error",
      usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: zeroCost },
    }),
  });
  assert.equal(partial[0]?.type === "usage" && partial[0].qualification, "reported");

  const normal = createPiEventMapper()({ type: "message_end", message: assistantMessage({ stopReason: "stop" }) });
  assert.deepEqual(normal, [
    {
      type: "usage",
      qualification: "reported",
      source: "turn",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    { type: "assistant_message", text: "", truncated: false },
  ]);
  assertAllParse(normal);
});

test("an unhandled SDK event maps to nothing", () => {
  const event: AgentSessionEvent = { type: "queue_update", steering: [], followUp: [] };
  assert.deepEqual(createPiEventMapper()(event), []);
});
