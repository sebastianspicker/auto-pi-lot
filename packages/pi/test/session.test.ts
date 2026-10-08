import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEvent } from "@auto-pi-lot/core/session";
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener } from "@earendil-works/pi-coding-agent";

import { openPiSession, type PiSessionFactory } from "../src/session.js";

/** A minimal stand-in for `AgentSession`; only the members `openPiSession` calls. */
function createFakeSession() {
  const listeners = new Set<AgentSessionEventListener>();
  const promptCalls: { text: string; options: unknown }[] = [];
  let aborted = false;
  let disposed = false;

  const session = {
    prompt: async (text: string, options?: unknown) => {
      promptCalls.push({ text, options });
    },
    abort: async () => {
      aborted = true;
    },
    dispose: () => {
      disposed = true;
    },
    subscribe: (listener: AgentSessionEventListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as AgentSession;

  return {
    session,
    emit: (event: AgentSessionEvent) => {
      for (const listener of listeners) listener(event);
    },
    promptCalls,
    isAborted: () => aborted,
    isDisposed: () => disposed,
  };
}

test("openPiSession maps subscribed events and delegates prompt/abort/dispose", async () => {
  const fake = createFakeSession();
  const factory = (async () => ({ session: fake.session })) as unknown as PiSessionFactory;

  const codingSession = await openPiSession(factory, undefined);

  const received: SessionEvent[] = [];
  const unsubscribe = codingSession.subscribe((event) => received.push(event));

  fake.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: {} });
  assert.deepEqual(received, [{ type: "tool_call", callId: "call-1", toolName: "read" }]);

  // An unmapped SDK event yields no delivered events.
  fake.emit({ type: "queue_update", steering: [], followUp: [] });
  assert.equal(received.length, 1);

  unsubscribe();
  fake.emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: {}, isError: false });
  assert.equal(received.length, 1, "no events delivered after unsubscribe");

  await codingSession.prompt("hello");
  assert.deepEqual(fake.promptCalls, [{ text: "hello", options: { expandPromptTemplates: false } }]);

  await codingSession.abort();
  assert.equal(fake.isAborted(), true);

  codingSession.dispose();
  assert.equal(fake.isDisposed(), true);
});

test("a throwing listener neither blocks remaining events nor other subscribers", async () => {
  const fake = createFakeSession();
  const factory = (async () => ({ session: fake.session })) as unknown as PiSessionFactory;
  const codingSession = await openPiSession(factory, undefined);

  const failure = new Error("consumer bug");
  const rethrown: unknown[] = [];
  const onUncaught = (error: unknown) => rethrown.push(error);
  // Capture the asynchronous rethrow so it cannot leak into other tests.
  const previous = process.listeners("uncaughtException");
  process.removeAllListeners("uncaughtException");
  process.on("uncaughtException", onUncaught);

  try {
    const first: SessionEvent[] = [];
    const second: SessionEvent[] = [];
    codingSession.subscribe((event) => {
      first.push(event);
      throw failure;
    });
    codingSession.subscribe((event) => second.push(event));

    fake.emit({ type: "agent_end", messages: [], willRetry: false });
    fake.emit({ type: "agent_settled" });
    fake.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: {} });

    const expected = [
      { type: "settled", reason: "aborted" },
      { type: "tool_call", callId: "call-1", toolName: "read" },
    ];
    assert.deepEqual(first, expected);
    assert.deepEqual(second, expected);

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(rethrown, [failure, failure]);
  } finally {
    process.removeListener("uncaughtException", onUncaught);
    for (const listener of previous) process.on("uncaughtException", listener);
  }
});
