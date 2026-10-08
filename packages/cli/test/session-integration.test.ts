import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { type CodingSession, canonicalJson, type GraphSpec, replay, type SessionEvent } from "@auto-pi-lot/core";
import { EvidenceGate, FileArtifactStore, FileEvidenceStore, FileJournalStore, RunHost } from "@auto-pi-lot/host";
import { SessionWorker, WorkspaceVerifier } from "@auto-pi-lot/worker";

/** Only the model is scripted. Workspace reads/writes, subprocess checks, storage and acceptance are real. */
function session(work: (packet: string) => Promise<object>): CodingSession {
  const listeners = new Set<(event: SessionEvent) => void>();
  return {
    async prompt(packet) {
      const report = await work(packet);
      for (const listener of listeners) {
        listener({
          type: "assistant_message",
          text: `\`\`\`json\n${JSON.stringify(report)}\n\`\`\``,
          truncated: false,
        });
        listener({ type: "settled", reason: "completed" });
      }
    },
    async abort() {},
    dispose() {
      listeners.clear();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

for (const breakEarlierWork of [false, true]) {
  test(`final checks ${breakEarlierWork ? "reject a later writer's regression" : "verify the combined tree"}`, {
    timeout: 15_000,
  }, async (t) => {
    const workspace = await mkdtemp(join(tmpdir(), "apl-final-tree-"));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const runtime = join(workspace, ".auto-pi-lot");
    const journal = new FileJournalStore(join(runtime, "journal"));
    const evidence = new FileEvidenceStore(join(runtime, "evidence"));
    const artifacts = new FileArtifactStore(join(runtime, "artifacts"));
    const checks = ["a", "b"].map((id) => ({
      id,
      command: process.execPath,
      args: ["-e", `if(require('node:fs').readFileSync('${id}.txt','utf8')!=='ready') process.exit(1)`],
    }));
    checks.push({
      id: "integration",
      command: process.execPath,
      args: ["-e", "const fs=require('node:fs'); fs.readFileSync('a.txt'); fs.readFileSync('b.txt');"],
    });
    let attempt = 0;
    const worker = new SessionWorker({
      workspace,
      checks,
      evidence,
      artifacts,
      openSession: async () =>
        session(async () => {
          attempt += 1;
          await writeFile(join(workspace, attempt === 1 ? "a.txt" : "b.txt"), "ready");
          if (attempt === 2 && breakEarlierWork) await writeFile(join(workspace, "a.txt"), "broken");
          return { summary: "Implemented", claims: [], limitations: [] };
        }),
    });
    const verifier = new WorkspaceVerifier({ workspace, checks, evidence, artifacts });
    t.after(() => worker.shutdown());
    t.after(() => verifier.shutdown());
    const graph: GraphSpec = {
      schemaVersion: 1,
      id: "combined",
      runId: "combined",
      depth: 0,
      revision: 1,
      nodes: ["a", "b"].map((id) => ({
        id,
        role: "implementer",
        objective: `Implement ${id}`,
        acceptanceCriteria: ["Ready"],
        checks: [id],
        limits: { maxTokens: 1000, maxToolCalls: 10 },
      })),
      edges: [{ from: "a", to: "b", condition: "accepted" }],
    };
    const host = await RunHost.start(
      { journal, worker, verifier, gate: new EvidenceGate({ evidence }) },
      graph,
      {
        maxConcurrent: 1,
        maxAttemptsPerNode: 1,
        requireFinalVerification: true,
      },
      {
        worker: "pi",
        workspace,
        checks,
        finalCheckIds: ["a", "b", "integration"],
        model: { provider: "test", id: "scripted" },
        thinkingLevel: "off",
      },
    );
    assert.equal(await host.completion, breakEarlierWork ? "failed" : "succeeded");
    assert.equal(host.state.nodes.a?.disposition, "accepted");
    assert.equal(host.state.nodes.b?.disposition, "accepted");
    assert.equal(host.state.verification?.outcome, breakEarlierWork ? "failed" : "passed");
    assert.equal(host.state.verification?.checkReceiptIds.length, 3);
    const records = await evidence.listForRun(graph.runId);
    assert.equal(records.filter((record) => record.kind === "check" && record.profileId === "integration").length, 1);
    for (const id of host.state.verification?.checkReceiptIds ?? []) {
      const receipt = await evidence.get(id);
      assert.equal(receipt?.kind, "check");
      if (receipt?.kind === "check") assert.equal(receipt.sourceDigest, host.state.verification?.sourceDigest);
    }
    const saved = await journal.read(graph.runId);
    assert.equal(saved.events.at(-1)?.type, "run_verified");
    assert.equal(canonicalJson(replay(saved.events).state), canonicalJson(host.state));
  });
}

for (const repair of [false, true]) {
  test(`real host/worker/gate ${repair ? "repairs a failed check" : "accepts checked and reviewed work"} and replays`, {
    timeout: 15_000,
  }, async (t) => {
    const workspace = await mkdtemp(join(tmpdir(), "apl-integration-"));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const runtime = join(workspace, ".auto-pi-lot");
    const evidence = new FileEvidenceStore(join(runtime, "evidence"));
    const artifacts = new FileArtifactStore(join(runtime, "artifacts"));
    const journal = new FileJournalStore(join(runtime, "journal"));
    const packets: string[] = [];
    let writes = 0;
    const worker = new SessionWorker({
      workspace,
      evidence,
      artifacts,
      checks: [
        {
          id: "unit",
          command: process.execPath,
          args: [
            "-e",
            "const fs=require('node:fs'); if(fs.readFileSync('product.txt','utf8')!=='ready') { console.error('expected ready'); process.exit(1); } console.log('verified product');",
          ],
        },
      ],
      openSession: async ({ role }) =>
        session(async (packet) => {
          packets.push(packet);
          if (role === "implementer") {
            writes += 1;
            await writeFile(join(workspace, "product.txt"), repair && writes === 1 ? "broken" : "ready");
            return { summary: "Wrote product", claims: ["Product is ready"], limitations: [] };
          }
          assert.equal(await readFile(join(workspace, "product.txt"), "utf8"), "ready");
          return {
            verdicts: [{ criterion: "Product is ready", verdict: "pass", evidence: "Read product.txt" }],
            limitations: [],
          };
        }),
    });
    t.after(() => worker.shutdown());
    const graph: GraphSpec = {
      schemaVersion: 1,
      id: "integration",
      runId: "integration-run",
      depth: 0,
      revision: 1,
      nodes: [
        {
          id: "implement",
          role: "implementer",
          objective: "Write product",
          acceptanceCriteria: ["Product is ready"],
          checks: ["unit"],
          limits: { maxTokens: 1000, maxToolCalls: 10 },
        },
        ...(!repair
          ? [
              {
                id: "review",
                role: "reviewer" as const,
                objective: "Review product",
                acceptanceCriteria: ["Judge product"],
                limits: { maxTokens: 1000, maxToolCalls: 10 },
              },
            ]
          : []),
      ],
      edges: repair ? [] : [{ from: "implement", to: "review", condition: "result_ready" }],
    };
    const ports = { journal, worker, gate: new EvidenceGate({ evidence }) };
    const host = await RunHost.start(ports, graph, {
      maxConcurrent: 1,
      maxAttemptsPerNode: 2,
      maxConcurrentWriters: 1,
    });
    assert.equal(await host.completion, "succeeded");
    assert.equal(host.state.nodes.implement?.attemptCount, repair ? 2 : 1);
    assert.equal(host.state.nodes.implement?.disposition, "accepted");
    const records = await evidence.listForRun(graph.runId);
    const checks = records.filter((record) => record.kind === "check");
    assert.equal(checks.filter((check) => check.outcome === "pass").length, 1);
    assert.equal(checks.filter((check) => check.outcome === "fail").length, repair ? 1 : 0);
    for (const receipt of checks) assert.ok(await artifacts.get(receipt.logArtifactIds[0] ?? ""));
    if (repair) assert.match(packets[1] ?? "", /expected ready/);
    else assert.equal(records.filter((record) => record.kind === "review").length, 1);
    const stored = await journal.read(graph.runId);
    const replayed = replay(stored.events);
    assert.deepEqual(replayed.rejections, []);
    assert.equal(canonicalJson(replayed.state), canonicalJson(host.state));
    const resumed = await RunHost.resume(ports, graph.runId);
    assert.equal(await resumed.completion, "succeeded");
    assert.equal(writes, repair ? 2 : 1);
  });
}
