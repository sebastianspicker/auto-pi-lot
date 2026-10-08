import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type AcceptanceRecord,
  type CheckReceipt,
  type EvidenceRecord,
  type EvidenceStore,
  identifyEvidence,
  type ResultProposal,
  type ReviewReceipt,
} from "@auto-pi-lot/core";

import {
  EvidenceCorruptError,
  FileArtifactStore,
  FileEvidenceStore,
  MAX_ARTIFACT_BYTES,
  MemoryArtifactStore,
  MemoryEvidenceStore,
} from "../src/index.js";

const RUN = "run-1";

function proposal(runId = RUN, summary = "did it"): ResultProposal {
  return identifyEvidence<ResultProposal>({
    kind: "proposal",
    schemaVersion: 1,
    runId,
    graphId: "g",
    graphRevision: 1,
    nodeId: "n",
    attemptId: "a1",
    summary,
    outputArtifactIds: [],
    claims: [],
    limitations: [],
    requestedChecks: [],
    checkReceiptIds: [],

    inputFingerprint: "fp",
  });
}

function check(runId = RUN): CheckReceipt {
  return identifyEvidence<CheckReceipt>({
    kind: "check",
    schemaVersion: 1,
    runId,
    attemptId: "a1",
    profileId: "unit",
    profileVersion: "1",
    executable: "npm",
    args: ["test"],
    environmentDigest: "env",
    inputDigest: "in",
    sourceDigest: "src",
    exitCode: 0,
    outcome: "pass",
    logArtifactIds: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
  });
}

function review(runId = RUN): ReviewReceipt {
  return identifyEvidence<ReviewReceipt>({
    kind: "review",
    schemaVersion: 1,
    runId,
    candidateDigest: "d",
    candidateAttemptId: "a1",
    reviewerAttemptId: "r1",
    verdicts: [{ criterion: "c", verdict: "pass", evidenceIds: [] }],
    limitations: [],
  });
}

function acceptance(runId = RUN): AcceptanceRecord {
  return identifyEvidence<AcceptanceRecord>({
    kind: "acceptance",
    schemaVersion: 1,
    runId,
    graphId: "g",
    graphRevision: 1,
    nodeId: "n",
    attemptId: "a1",
    proposalDigest: "d",
    inputFingerprint: "fp",
    decision: "accepted",
    checkReceiptIds: ["c1"],
    reviewReceiptIds: [],
    policyRevision: 1,
    decidedAt: "2026-01-01T00:00:00.000Z",
  });
}

async function withTempDir(body: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "evidence-test-"));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function exerciseEvidenceStore(store: EvidenceStore): Promise<void> {
  const records: EvidenceRecord[] = [proposal(), check(), review(), acceptance()];
  for (const record of records) {
    assert.equal(await store.put(record), record.id);
    assert.deepEqual(await store.get(record.id), record);
  }
  assert.equal(await store.get(`sha256:${"0".repeat(64)}`), null);

  // idempotent
  assert.equal(await store.put(records[0] as EvidenceRecord), (records[0] as EvidenceRecord).id);
  assert.equal((await store.listForRun(RUN)).length, 4);

  // scoped to the run and sorted by id
  const other = proposal("other-run");
  await store.put(other);
  const listed = await store.listForRun(RUN);
  assert.deepEqual(
    listed.map((r) => r.id),
    records.map((r) => r.id).sort(),
  );
  assert.deepEqual(
    (await store.listForRun("other-run")).map((r) => r.id),
    [other.id],
  );
  assert.deepEqual(await store.listForRun("unknown"), []);

  // id mismatch and invalid records
  await assert.rejects(store.put({ ...proposal(), summary: "tampered" }));
  await assert.rejects(store.put({ ...proposal(), id: "wrong" }));
  await assert.rejects(store.put({ ...check(), outcome: "maybe" } as unknown as EvidenceRecord));
  await assert.rejects(store.put({ kind: "nope" } as unknown as EvidenceRecord));
}

test("MemoryEvidenceStore round trips, scopes and validates", async () => {
  await exerciseEvidenceStore(new MemoryEvidenceStore());
});

test("MemoryEvidenceStore copies records on the way in and out", async () => {
  const store = new MemoryEvidenceStore();
  const record = proposal();
  await store.put(record);
  const got = (await store.get(record.id)) as ResultProposal;
  got.summary = "mutated";
  assert.equal(((await store.get(record.id)) as ResultProposal).summary, "did it");
});

test("FileEvidenceStore round trips, scopes and validates", async () => {
  await withTempDir(async (directory) => {
    await exerciseEvidenceStore(new FileEvidenceStore(directory));
  });
});

test("FileEvidenceStore uses the documented layout and survives a new instance", async () => {
  await withTempDir(async (directory) => {
    const record = proposal("Run/1");
    await new FileEvidenceStore(directory).put(record);
    const runDirectories = await readdir(directory);
    assert.deepEqual(runDirectories, ["run-%52un%2f1"]);
    const files = await readdir(join(directory, runDirectories[0] as string));
    assert.deepEqual(files, [`proposal-${record.id.slice("sha256:".length)}.json`]);
    assert.deepEqual(await new FileEvidenceStore(directory).get(record.id), record);
  });
});

test("FileEvidenceStore throws EvidenceCorruptError for a damaged file", async () => {
  await withTempDir(async (directory) => {
    const store = new FileEvidenceStore(directory);
    const record = proposal();
    await store.put(record);
    const run = (await readdir(directory))[0] as string;
    const path = join(directory, run, `proposal-${record.id.slice("sha256:".length)}.json`);

    await writeFile(path, JSON.stringify({ ...record, summary: "changed" }));
    await assert.rejects(store.get(record.id), (error: unknown) => {
      assert.ok(error instanceof EvidenceCorruptError);
      assert.equal(error.path, path);
      return true;
    });
    await assert.rejects(store.listForRun(RUN), EvidenceCorruptError);

    await writeFile(path, "{ not json");
    await assert.rejects(store.get(record.id), EvidenceCorruptError);
    // A corrupt file is never silently replaced.
    await assert.rejects(store.put(record), EvidenceCorruptError);
    assert.equal(await readFile(path, "utf8"), "{ not json");
  });
});

async function exerciseArtifactStore(store: MemoryArtifactStore | FileArtifactStore): Promise<void> {
  const bytes = new TextEncoder().encode("log output");
  const id = await store.put(bytes);
  assert.match(id, /^sha256:[0-9a-f]{64}$/);
  assert.equal(await store.put(bytes), id);
  assert.deepEqual(await store.get(id), bytes);
  assert.equal(await store.get(`sha256:${"1".repeat(64)}`), null);
  await assert.rejects(store.put(new Uint8Array(MAX_ARTIFACT_BYTES + 1)));
}

test("MemoryArtifactStore round trips and bounds size", async () => {
  await exerciseArtifactStore(new MemoryArtifactStore());
});

test("FileArtifactStore round trips and bounds size", async () => {
  await withTempDir(async (directory) => {
    await exerciseArtifactStore(new FileArtifactStore(join(directory, "artifacts")));
  });
});

test("FileArtifactStore detects corruption on read", async () => {
  await withTempDir(async (directory) => {
    const store = new FileArtifactStore(directory);
    const id = await store.put(new TextEncoder().encode("original"));
    await writeFile(join(directory, id.slice("sha256:".length)), "altered");
    await assert.rejects(store.get(id), EvidenceCorruptError);
  });
});
