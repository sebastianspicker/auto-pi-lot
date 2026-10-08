import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_ATTEMPT_TIMEOUT_MS, MAX_ATTEMPT_TIMEOUT_MS, NodeLimitsSchema } from "../src/index.js";

test("attempt timeouts stay finite while older plans retain their original shape", () => {
  const legacy = { maxTokens: 1000, maxToolCalls: 10 };
  assert.deepEqual(NodeLimitsSchema.parse(legacy), legacy);
  assert.equal(DEFAULT_ATTEMPT_TIMEOUT_MS, 1_800_000);
  for (const timeoutMs of [0, -1, 0.5, Infinity, MAX_ATTEMPT_TIMEOUT_MS + 1]) {
    assert.equal(NodeLimitsSchema.safeParse({ ...legacy, timeoutMs }).success, false);
  }
  assert.equal(NodeLimitsSchema.safeParse({ ...legacy, timeoutMs: MAX_ATTEMPT_TIMEOUT_MS }).success, true);
});
