import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalJson,
  decide,
  type GraphSpec,
  type JournalStore,
  type RunVerificationResult,
  replay,
} from "@auto-pi-lot/core";
import { MemoryJournalStore, RunHost, ScriptedGate, ScriptedWorker } from "../src/index.js";

const graph: GraphSpec = {
  schemaVersion: 1,
  id: "final-graph",
  runId: "final-run",
  depth: 0,
  revision: 1,
  nodes: [
    {
      id: "work",
      role: "implementer",
      objective: "Work",
      acceptanceCriteria: ["Done"],
      checks: ["unit"],
      limits: { maxTokens: 10, maxToolCalls: 10 },
    },
  ],
  edges: [],
};
const policy = { maxConcurrent: 1, maxAttemptsPerNode: 1, requireFinalVerification: true };
const passed: RunVerificationResult = {
  outcome: "passed",
  sourceDigest: "sha256:final-tree",
  checkProfileIds: ["unit"],
  checkReceiptIds: ["receipt-final"],
  reasons: [],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("final verification runs after durable task acceptance and is required before success", async () => {
  const journal = new MemoryJournalStore();
  let calls = 0;
  const host = await RunHost.start(
    {
      journal,
      worker: new ScriptedWorker(),
      gate: new ScriptedGate(),
      verifier: {
        async verify() {
          calls += 1;
          const saved = await journal.read(graph.runId);
          assert.equal(replay(saved.events).state.status, "verifying");
          assert.ok(Object.values(replay(saved.events).state.nodes).every((node) => node.disposition === "accepted"));
          return passed;
        },
        cancel() {},
      },
    },
    graph,
    policy,
  );
  assert.equal(await host.completion, "succeeded");
  assert.equal(calls, 1);
  assert.deepEqual(host.state.verification, passed);
  const stored = await journal.read(graph.runId);
  assert.equal(stored.events.at(-1)?.type, "run_verified");
  assert.equal(canonicalJson(replay(stored.events).state), canonicalJson(host.state));
  const last = stored.events.at(-1);
  assert.ok(last);
  assert.equal(decide(host.state, last).rejection?.code, "duplicate_event");
  assert.equal(decide(host.state, { ...last, eventId: "late-final-result" }).rejection?.code, "run_terminal");
});

test("a failed final check leaves accepted tasks in a failed run", async () => {
  const host = await RunHost.start(
    {
      journal: new MemoryJournalStore(),
      worker: new ScriptedWorker(),
      gate: new ScriptedGate(),
      verifier: {
        async verify() {
          return { ...passed, outcome: "failed", reasons: ["unit: fail"] };
        },
        cancel() {},
      },
    },
    graph,
    policy,
  );
  assert.equal(await host.completion, "failed");
  assert.equal(host.state.nodes.work?.disposition, "accepted");
  assert.equal(host.state.verification?.outcome, "failed");
});

test("cancelling final checks waits for cleanup and wins a racing pass", { timeout: 3000 }, async () => {
  const started = deferred<void>();
  const finish = deferred<RunVerificationResult>();
  let cancelled = false;
  const host = await RunHost.start(
    {
      journal: new MemoryJournalStore(),
      worker: new ScriptedWorker(),
      gate: new ScriptedGate(),
      verifier: {
        verify() {
          started.resolve();
          return finish.promise;
        },
        cancel() {
          cancelled = true;
        },
      },
    },
    graph,
    policy,
  );
  await started.promise;
  await host.cancel("operator");
  assert.equal(cancelled, true);
  assert.equal(host.state.status, "cancelling");
  assert.equal(host.state.verificationRequested, true);
  finish.resolve(passed);
  assert.equal(await host.completion, "cancelled");
});

test("a failed final journal append never exposes success and resume reruns verification", async () => {
  const saved = new MemoryJournalStore();
  const journal: JournalStore = {
    read: (id) => saved.read(id),
    async append(event) {
      if (event.type === "run_verified") throw new Error("simulated final append failure");
      await saved.append(event);
    },
  };
  const host = await RunHost.start(
    {
      journal,
      worker: new ScriptedWorker(),
      gate: new ScriptedGate(),
      verifier: {
        async verify() {
          return passed;
        },
        cancel() {},
      },
    },
    graph,
    policy,
  );
  await assert.rejects(host.completion, /simulated final append failure/);
  assert.equal(replay((await saved.read(graph.runId)).events).state.status, "verifying");
  let reran = 0;
  const recovered = await RunHost.resume(
    {
      journal: saved,
      worker: new ScriptedWorker(),
      gate: new ScriptedGate(),
      verifier: {
        async verify() {
          reran += 1;
          return passed;
        },
        cancel() {},
      },
    },
    graph.runId,
  );
  assert.equal(await recovered.completion, "succeeded");
  assert.equal(reran, 1);
});

test("final verification that omits a required profile is refused", async () => {
  const journal = new MemoryJournalStore();
  const host = await RunHost.start(
    {
      journal,
      worker: new ScriptedWorker(),
      gate: new ScriptedGate(),
      verifier: {
        async verify() {
          return { ...passed, checkProfileIds: [], checkReceiptIds: [] };
        },
        cancel() {},
      },
    },
    graph,
    policy,
  );
  await assert.rejects(host.completion, /Final verification result was refused/);
  assert.equal(replay((await journal.read(graph.runId)).events).state.status, "verifying");
});

test("requiring final verification without its implementation is rejected before journaling", async () => {
  const journal = new MemoryJournalStore();
  await assert.rejects(
    RunHost.start({ journal, worker: new ScriptedWorker(), gate: new ScriptedGate() }, graph, policy),
    /requires a verifier/,
  );
  assert.equal((await journal.read(graph.runId)).events.length, 0);
});

test("terminal verified runs can resume without a verifier", async () => {
  const journal = new MemoryJournalStore();
  const basePorts = { journal, worker: new ScriptedWorker(), gate: new ScriptedGate() };
  const host = await RunHost.start(
    {
      ...basePorts,
      verifier: {
        async verify() {
          return passed;
        },
        cancel() {},
      },
    },
    graph,
    policy,
  );
  assert.equal(await host.completion, "succeeded");
  const before = (await journal.read(graph.runId)).events.length;
  const resumed = await RunHost.resume(basePorts, graph.runId);
  assert.equal(await resumed.completion, "succeeded");
  assert.equal((await journal.read(graph.runId)).events.length, before);
});

test("manifest final-only checks cannot be omitted from a passing result", async () => {
  const journal = new MemoryJournalStore();
  const host = await RunHost.start(
    {
      journal,
      worker: new ScriptedWorker(),
      gate: new ScriptedGate(),
      verifier: {
        async verify() {
          return passed;
        },
        cancel() {},
      },
    },
    graph,
    policy,
    {
      worker: "pi",
      workspace: "/project",
      model: { provider: "test", id: "test" },
      thinkingLevel: "off",
      checks: ["unit", "integration"].map((id) => ({ id, command: "test", args: [] })),
      finalCheckIds: ["unit", "integration"],
    },
  );
  await assert.rejects(host.completion, /Final verification result was refused/);
  assert.equal(replay((await journal.read(graph.runId)).events).state.status, "verifying");
});
