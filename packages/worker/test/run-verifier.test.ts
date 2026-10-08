import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ArtifactStore, digest, type EvidenceRecord, type EvidenceStore } from "@auto-pi-lot/core";
import { WorkspaceVerifier } from "../src/index.js";

function stores() {
  const records = new Map<string, EvidenceRecord>();
  const blobs = new Map<string, Uint8Array>();
  const evidence: EvidenceStore = {
    async put(record) {
      records.set(record.id, record);
      return record.id;
    },
    async get(id) {
      return records.get(id) ?? null;
    },
    async listForRun(runId) {
      return [...records.values()].filter((record) => record.runId === runId);
    },
  };
  const artifacts: ArtifactStore = {
    async put(bytes) {
      const id = digest([...bytes]);
      blobs.set(id, bytes);
      return id;
    },
    async get(id) {
      return blobs.get(id) ?? null;
    },
  };
  return { evidence, artifacts };
}

test("final verification stops after source drift and preserves its check receipt and logs", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "apl-final-drift-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, "source.txt"), "before");
  const { evidence, artifacts } = stores();
  const verifier = new WorkspaceVerifier({
    workspace,
    evidence,
    artifacts,
    checks: [
      {
        id: "mutator",
        command: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync('source.txt','after'); console.log('changed source')"],
      },
      { id: "later", command: process.execPath, args: ["-e", "throw new Error('must not run')"] },
    ],
  });
  const result = await verifier.verify("final-drift");
  assert.equal(result.outcome, "failed");
  assert.match(result.reasons.join(" "), /Source changed/);
  assert.equal(result.checkReceiptIds.length, 1);
  const record = await evidence.get(result.checkReceiptIds[0] ?? "");
  assert.equal(record?.kind, "check");
  if (record?.kind === "check") {
    assert.equal(record.sourceDigest, result.sourceDigest);
    assert.equal(record.outcome, "pass");
    assert.ok(await artifacts.get(record.logArtifactIds[0] ?? ""));
  }
  assert.deepEqual(await verifier.verify("final-drift"), result);
});

test("a cancelled verifier never runs a check or fingerprints source", async () => {
  const verifier = new WorkspaceVerifier({
    workspace: "/unused",
    ...stores(),
    checks: [],
    async fingerprint() {
      throw new Error("must not fingerprint");
    },
  });
  verifier.cancel();
  const result = await verifier.verify("cancelled");
  assert.equal(result.outcome, "cancelled");
  assert.equal(result.sourceDigest, undefined);
  assert.deepEqual(result.checkReceiptIds, []);
});

test("source capture failure becomes a failed verification rather than success", async () => {
  const verifier = new WorkspaceVerifier({
    workspace: "/unused",
    ...stores(),
    checks: [],
    async fingerprint() {
      throw new Error("capture unavailable");
    },
  });
  const result = await verifier.verify("capture-failure");
  assert.equal(result.outcome, "failed");
  assert.match(result.reasons.join(" "), /capture unavailable/);
});
