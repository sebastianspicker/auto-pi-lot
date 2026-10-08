import assert from "node:assert/strict";
import test from "node:test";
import type { DispatchCommand } from "@auto-pi-lot/core";
import { demoGraphInput } from "../src/demo.js";
import { buildTrace, type TraceOutput } from "../src/trace.js";

const EXPECTED_DEMO_OUTPUT = {
  mode: "plan-only-demo",
  graph: demoGraphInput,
  topologicalOrder: ["implement", "verify", "review"],
  readyNodeIds: ["implement"],
};

function findScenario(trace: TraceOutput, id: string) {
  const scenario = trace.scenarios.find((s) => s.id === id);
  assert.ok(scenario, `scenario "${id}" not found`);
  return scenario;
}

test("trace declares formatVersion 3", () => {
  assert.equal(buildTrace().formatVersion, 3);
});

test("every step snapshots the attempts the reducer knows, and the repair trace shows verify's invalidated attempts", () => {
  const trace = buildTrace();
  for (const scenario of trace.scenarios) {
    for (const step of scenario.steps) {
      for (const [attemptId, attempt] of Object.entries(step.attempts)) {
        assert.ok(
          scenario.graph.nodes.some((node) => node.id === attempt.nodeId),
          `${attemptId} names an unknown node`,
        );
        assert.ok(attempt.fencingToken > 0);
      }
    }
  }
  const repair = findScenario(trace, "repair");
  const last = repair.steps[repair.steps.length - 1];
  assert.ok(last);
  const byNode = (nodeId: string) =>
    Object.values(last.attempts)
      .filter((attempt) => attempt.nodeId === nodeId)
      .sort((a, b) => a.fencingToken - b.fencingToken)
      .map((attempt) => [attempt.status, attempt.invalidated]);
  assert.deepEqual(byNode("implement"), [
    ["superseded", false],
    ["superseded", false],
    ["accepted", false],
  ]);
  assert.deepEqual(byNode("verify"), [
    ["invalidated", true],
    ["stopped", true],
    ["accepted", false],
  ]);
  assert.deepEqual(byNode("review"), [["accepted", false]]);
});

test("trace output is deterministic across runs", () => {
  const first = buildTrace();
  const second = buildTrace();
  assert.deepEqual(first, second);
});

test("trace has the four named scenarios in order with the expected final statuses", () => {
  const trace = buildTrace();
  assert.deepEqual(
    trace.scenarios.map((s) => s.id),
    ["happy-path", "retry-and-fencing", "cancellation", "repair"],
  );

  const expectedFinalStatus: Record<string, string> = {
    "happy-path": "succeeded",
    "retry-and-fencing": "succeeded",
    cancellation: "cancelled",
    repair: "succeeded",
  };
  for (const scenario of trace.scenarios) {
    assert.equal(scenario.finalStatus, expectedFinalStatus[scenario.id]);
    assert.equal(scenario.replayMatches, true, `scenario "${scenario.id}" did not replay to the same state`);
  }
});

test("happy-path: verify dispatches while implement is verifying, implement is accepted only after verify, review after verify", () => {
  const trace = buildTrace();
  const scenario = findScenario(trace, "happy-path");

  const verifyDispatchStep = scenario.steps.find((step) =>
    step.commands.some((c) => c.type === "dispatch" && c.nodeId === "verify"),
  );
  assert.ok(verifyDispatchStep, "expected a step dispatching verify");
  assert.equal(verifyDispatchStep.nodes.implement?.execution, "result_ready");
  assert.equal(verifyDispatchStep.nodes.implement?.disposition, "verifying");
  assert.ok(
    verifyDispatchStep.commands.every((c) => c.type !== "evaluate_acceptance"),
    "implement must not be evaluated while it is verifying",
  );

  const verifyAcceptedIndex = scenario.steps.findIndex(
    (step) =>
      step.event.type === "acceptance_decided" && step.event.nodeId === "verify" && step.event.decision === "accepted",
  );
  assert.notEqual(verifyAcceptedIndex, -1, "expected a step accepting verify");

  const earlyRejectionIndex = scenario.steps.findIndex(
    (step) =>
      step.outcome === "rejected" &&
      step.rejection?.code === "verification_incomplete" &&
      step.event.type === "acceptance_decided" &&
      step.event.nodeId === "implement",
  );
  assert.notEqual(earlyRejectionIndex, -1, "expected a verification_incomplete rejection for implement");
  assert.ok(earlyRejectionIndex < verifyAcceptedIndex, "the early acceptance must come before verify is accepted");

  const reviewDispatchIndex = scenario.steps.findIndex((step) =>
    step.commands.some((c) => c.type === "dispatch" && c.nodeId === "review"),
  );
  assert.notEqual(reviewDispatchIndex, -1, "expected a step dispatching review");
  assert.ok(
    reviewDispatchIndex >= verifyAcceptedIndex,
    "review must dispatch no earlier than the step that accepts verify",
  );
});

test("retry-and-fencing: contains a stale_fencing_token rejection and a retry with a different attempt id", () => {
  const trace = buildTrace();
  const scenario = findScenario(trace, "retry-and-fencing");

  const staleFencingStep = scenario.steps.find(
    (step) => step.outcome === "rejected" && step.rejection?.code === "stale_fencing_token",
  );
  assert.ok(staleFencingStep, "expected a stale_fencing_token rejection");

  const dispatchedAttemptIds = scenario.steps
    .filter((step) => step.event.type === "attempt_dispatched" && step.event.nodeId === "implement")
    .map((step) => (step.event as { attemptId: string }).attemptId);
  assert.ok(dispatchedAttemptIds.length >= 2, "expected implement to be dispatched more than once");
  assert.notEqual(dispatchedAttemptIds[0], dispatchedAttemptIds[1]);
});

test("cancellation: no dispatch command appears after cancel_requested, and it contains a run_terminal rejection", () => {
  const trace = buildTrace();
  const scenario = findScenario(trace, "cancellation");

  const cancelIndex = scenario.steps.findIndex((step) => step.event.type === "cancel_requested");
  assert.notEqual(cancelIndex, -1, "expected a cancel_requested step");

  for (const step of scenario.steps.slice(cancelIndex + 1)) {
    assert.ok(
      step.commands.every((c) => c.type !== "dispatch"),
      `unexpected dispatch command after cancel_requested at step ${step.index}`,
    );
  }

  const runTerminalStep = scenario.steps.find(
    (step) => step.outcome === "rejected" && step.rejection?.code === "run_terminal",
  );
  assert.ok(runTerminalStep, "expected a run_terminal rejection");
});

test("repair: a stale_candidate rejection, repairing dispatches, and verify's attempts are invalidated rather than spent", () => {
  const trace = buildTrace();
  const scenario = findScenario(trace, "repair");

  const staleStep = scenario.steps.find(
    (step) => step.outcome === "rejected" && step.rejection?.code === "stale_candidate",
  );
  assert.ok(staleStep, "expected a stale_candidate rejection");

  const implementDispatches = scenario.steps.flatMap((step) =>
    step.commands.filter((c): c is DispatchCommand => c.type === "dispatch" && c.nodeId === "implement"),
  );
  assert.equal(implementDispatches.length, 3);
  const [first, second, third] = implementDispatches;
  assert.ok(first && second && third);
  assert.equal(first.repairOf, null);
  assert.deepEqual(second.repairOf, { attemptId: first.attemptId, receiptIds: ["check-verify-1"] });
  assert.deepEqual(third.repairOf, { attemptId: second.attemptId, receiptIds: ["check-implement-2"] });

  const last = scenario.steps[scenario.steps.length - 1];
  assert.ok(last);
  assert.equal(last.nodes.verify?.attemptCount, 3);
  assert.equal(last.nodes.verify?.invalidatedAttemptCount, 2);
});

test("demo command output is unchanged", async () => {
  const { runDemo } = await import("../src/demo.js");
  const originalLog = console.log;
  let captured: string | undefined;
  console.log = (...args: unknown[]) => {
    captured = args.join(" ");
  };
  try {
    runDemo();
  } finally {
    console.log = originalLog;
  }
  assert.ok(captured !== undefined, "runDemo did not print anything");
  assert.deepEqual(JSON.parse(captured), EXPECTED_DEMO_OUTPUT);
});
