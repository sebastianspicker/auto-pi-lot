import assert from "node:assert/strict";
import test from "node:test";

import { getReadyNodes, isDependencySatisfied, type NodeStatus, parseGraphSpec } from "../src/index.js";

const accepted: NodeStatus = { execution: "result_ready", disposition: "accepted" };
const running: NodeStatus = { execution: "running" };

const joinGraph = parseGraphSpec({
  schemaVersion: 1,
  id: "graph",
  runId: "run",
  depth: 0,
  revision: 1,
  nodes: ["a", "b", "join"].map((id) => ({
    id,
    role: "explorer",
    objective: `Investigate ${id}`,
    acceptanceCriteria: ["Evidence returned"],
    limits: { maxTokens: 1000, maxToolCalls: 10 },
  })),
  edges: [
    { from: "a", to: "join", condition: "accepted" },
    { from: "b", to: "join", condition: "accepted" },
  ],
});

test("independent roots are ready; a join waits for all accepted predecessors", () => {
  assert.deepEqual(
    getReadyNodes(joinGraph, new Map()).map((node) => node.id),
    ["a", "b"],
  );
  assert.deepEqual(
    getReadyNodes(
      joinGraph,
      new Map([
        ["a", accepted],
        ["b", running],
      ]),
    ),
    [],
  );
  assert.deepEqual(
    getReadyNodes(
      joinGraph,
      new Map([
        ["a", accepted],
        ["b", accepted],
      ]),
    ).map((node) => node.id),
    ["join"],
  );
});

test("waiting, failed, rejected, or invalidated work never unlocks an accepted-edge dependent", () => {
  const blockingStates: NodeStatus[] = [
    { execution: "waiting_children" },
    { execution: "result_ready", disposition: "unverified" },
    { execution: "failed" },
    { execution: "cancelled" },
    { execution: "result_ready", disposition: "rejected" },
    { execution: "result_ready", disposition: "invalidated" },
  ];
  for (const state of blockingStates) {
    assert.deepEqual(
      getReadyNodes(
        joinGraph,
        new Map([
          ["a", accepted],
          ["b", state],
        ]),
      ),
      [],
    );
  }
});

test("state belonging to another graph is rejected", () => {
  assert.throws(() => getReadyNodes(joinGraph, new Map([["unknown", accepted]])), /unknown node/);
});

const pipelineGraph = parseGraphSpec({
  schemaVersion: 1,
  id: "graph-pipeline",
  runId: "run",
  depth: 0,
  revision: 1,
  nodes: [
    {
      id: "implement",
      role: "implementer",
      objective: "Do implement",
      acceptanceCriteria: ["Done"],
      limits: { maxTokens: 1000, maxToolCalls: 10 },
    },
    {
      id: "verify",
      role: "verifier",
      objective: "Do verify",
      acceptanceCriteria: ["Done"],
      limits: { maxTokens: 1000, maxToolCalls: 10 },
    },
    {
      id: "review",
      role: "reviewer",
      objective: "Do review",
      acceptanceCriteria: ["Done"],
      limits: { maxTokens: 1000, maxToolCalls: 10 },
    },
  ],
  edges: [
    { from: "implement", to: "verify", condition: "result_ready" },
    { from: "verify", to: "review", condition: "accepted" },
  ],
});

test("a verifier consumes a provisional result_ready edge while an accepted consumer stays blocked", () => {
  const unverified: NodeStatus = { execution: "result_ready", disposition: "unverified" };
  assert.deepEqual(
    getReadyNodes(pipelineGraph, new Map([["implement", unverified]])).map((node) => node.id),
    ["verify"],
  );

  const verifying: NodeStatus = { execution: "result_ready", disposition: "verifying" };
  assert.deepEqual(
    getReadyNodes(
      pipelineGraph,
      new Map([
        ["implement", unverified],
        ["verify", verifying],
      ]),
    ).map((node) => node.id),
    [],
  );
});

test("rejected, invalidated, or failed implementer output never unlocks its verifier", () => {
  const blockingStates: NodeStatus[] = [
    { execution: "result_ready", disposition: "rejected" },
    { execution: "result_ready", disposition: "invalidated" },
    { execution: "failed" },
  ];
  for (const state of blockingStates) {
    assert.deepEqual(getReadyNodes(pipelineGraph, new Map([["implement", state]])), []);
  }
});

test("readiness is returned in topological order", () => {
  assert.deepEqual(
    getReadyNodes(
      pipelineGraph,
      new Map([
        ["implement", accepted],
        ["verify", accepted],
      ]),
    ).map((node) => node.id),
    ["review"],
  );
});

test("AT-09: isDependencySatisfied truth table", () => {
  assert.equal(isDependencySatisfied("accepted", { execution: "result_ready", disposition: "accepted" }), true);
  assert.equal(isDependencySatisfied("accepted", { execution: "result_ready", disposition: "unverified" }), false);
  assert.equal(isDependencySatisfied("accepted", { execution: "result_ready", disposition: "rejected" }), false);
  assert.equal(isDependencySatisfied("accepted", { execution: "pending" }), false);

  assert.equal(isDependencySatisfied("result_ready", { execution: "result_ready", disposition: "unverified" }), true);
  assert.equal(isDependencySatisfied("result_ready", { execution: "result_ready", disposition: "verifying" }), true);
  assert.equal(isDependencySatisfied("result_ready", { execution: "result_ready", disposition: "accepted" }), true);
  assert.equal(isDependencySatisfied("result_ready", { execution: "result_ready", disposition: "rejected" }), false);
  assert.equal(isDependencySatisfied("result_ready", { execution: "result_ready", disposition: "invalidated" }), false);
  assert.equal(isDependencySatisfied("result_ready", { execution: "result_ready" }), false);
  assert.equal(isDependencySatisfied("result_ready", { execution: "running" }), false);
  assert.equal(isDependencySatisfied("result_ready", { execution: "failed" }), false);
});
