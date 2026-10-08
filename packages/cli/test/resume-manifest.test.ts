import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ExecutionManifest, GraphSpec, RunStartedEvent } from "@auto-pi-lot/core";
import { FileJournalStore, RunHost, ScriptedGate, ScriptedWorker } from "@auto-pi-lot/host";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", timeout: 15_000 });

test("resume previews pinned execution despite a broken current config and refuses overrides", async (t) => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "apl-manifest-")));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const graph: GraphSpec = {
    schemaVersion: 1,
    id: "plan",
    runId: "pinned",
    depth: 0,
    revision: 1,
    nodes: [
      {
        id: "work",
        role: "implementer",
        objective: "Work",
        acceptanceCriteria: ["Done"],
        checks: ["unit"],
        limits: { maxTokens: 1000, maxToolCalls: 10 },
      },
    ],
    edges: [],
  };
  const execution: ExecutionManifest = {
    worker: "pi",
    workspace,
    model: { provider: "test", id: "pinned-model" },
    thinkingLevel: "low",
    checks: ["unit", "integration"].map((id) => ({
      id,
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: ".",
      timeoutMs: 1000,
    })),
    finalCheckIds: ["unit", "integration"],
  };
  const event: RunStartedEvent = {
    type: "run_started",
    schemaVersion: 1,
    eventId: "start",
    runId: graph.runId,
    at: new Date().toISOString(),
    graph,
    policy: { maxConcurrent: 1, maxAttemptsPerNode: 1, requireFinalVerification: true },
    execution,
  };
  const journal = new FileJournalStore(join(workspace, ".auto-pi-lot", "journal"));
  await journal.append(event);
  const before = await readFile(journal.pathFor(graph.runId), "utf8");
  await writeFile(join(workspace, "auto-pi-lot.json"), "invalid current config");
  const args = ["run", "--resume", graph.runId, "--worker", "pi", "--workspace", workspace, "--dry-run"];
  const result = run(...args);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.configurationSource, "journal");
  assert.deepEqual(output.model, execution.model);
  assert.equal(output.thinkingLevel, "low");
  assert.equal(output.checks[0].timeoutMs, 1000);
  assert.deepEqual(output.finalCheckIds, ["unit", "integration"]);
  assert.equal(output.checks.length, 2);
  for (const override of [
    ["--model", "test/other"],
    ["--thinking", "high"],
    ["--config", "other.json"],
  ]) {
    const refused = run(...args, ...override);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /cannot/);
  }
  const fake = run("run", "--resume", graph.runId, "--worker", "fake", "--workspace", workspace, "--dry-run");
  assert.equal(fake.status, 1);
  assert.match(fake.stderr, /worker kind cannot change/);
  assert.equal(await readFile(journal.pathFor(graph.runId), "utf8"), before);
  const inspected = run("inspect", graph.runId, "--workspace", workspace);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.deepEqual(JSON.parse(inspected.stdout).execution, execution);
  const completed = await RunHost.resume(
    {
      journal,
      worker: new ScriptedWorker(),
      gate: new ScriptedGate(),
      verifier: {
        async verify() {
          return {
            outcome: "passed",
            sourceDigest: "final-tree",
            checkProfileIds: ["unit", "integration"],
            checkReceiptIds: ["unit-receipt", "integration-receipt"],
            reasons: [],
          };
        },
        cancel() {},
      },
    },
    graph.runId,
  );
  assert.equal(await completed.completion, "succeeded");
  const completedBytes = await readFile(journal.pathFor(graph.runId), "utf8");
  const resumed = run(...args.filter((arg) => arg !== "--dry-run"));
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).finalStatus, "succeeded");
  assert.equal(await readFile(journal.pathFor(graph.runId), "utf8"), completedBytes);
});

test("manifest-less journals remain inspectable but cannot resume through the CLI", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "apl-legacy-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const journal = new FileJournalStore(join(workspace, ".auto-pi-lot", "journal"));
  const graph: GraphSpec = {
    schemaVersion: 1,
    id: "legacy",
    runId: "legacy",
    depth: 0,
    revision: 1,
    nodes: [
      {
        id: "work",
        role: "implementer",
        objective: "Work",
        acceptanceCriteria: ["Done"],
        limits: { maxTokens: 10, maxToolCalls: 10 },
      },
    ],
    edges: [],
  };
  await journal.append({
    type: "run_started",
    schemaVersion: 1,
    eventId: "start",
    runId: graph.runId,
    at: new Date().toISOString(),
    graph,
    policy: { maxConcurrent: 1, maxAttemptsPerNode: 1 },
  });
  assert.equal(run("inspect", "legacy", "--workspace", workspace).status, 0);
  const result = run("run", "--resume", "legacy", "--worker", "fake", "--workspace", workspace);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no execution manifest/);
});
