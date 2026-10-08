import assert from "node:assert/strict";
import test from "node:test";

import {
  AcceptanceRecordSchema,
  CheckReceiptSchema,
  type EvidenceRecord,
  EvidenceRecordSchema,
  identifyEvidence,
  parseDto,
  ResultProposalSchema,
  ReviewReceiptSchema,
} from "../src/index.js";

const proposalBase = {
  kind: "proposal",
  schemaVersion: 1,
  id: "proposal-1",
  runId: "run-1",
  graphId: "graph-1",
  graphRevision: 1,
  nodeId: "implement",
  attemptId: "attempt-1",
  summary: "Patch is ready",
  outputArtifactIds: ["artifact-1"],
  claims: ["Feature works"],
  limitations: [],
  requestedChecks: ["unit-tests"],
  checkReceiptIds: [],

  inputFingerprint: "sha256:inputs",
};

test("AT-08: a result proposal cannot self-accept", () => {
  assert.ok(ResultProposalSchema.safeParse(proposalBase).success);
  assert.ok(!ResultProposalSchema.safeParse({ ...proposalBase, status: "accepted" }).success);
  assert.ok(!ResultProposalSchema.safeParse({ ...proposalBase, accepted: true }).success);
});

test("AT-03: an unsupported schema version on a result proposal is a typed issue, not a throw", () => {
  assert.doesNotThrow(() => parseDto(ResultProposalSchema, { ...proposalBase, schemaVersion: 2 }));
  const result = parseDto(ResultProposalSchema, { ...proposalBase, schemaVersion: 2 });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((issue) => issue.code === "unsupported_schema_version"));
  }
});

test("AT-03: an unknown field on a result proposal is a typed issue, not a throw", () => {
  assert.doesNotThrow(() => parseDto(ResultProposalSchema, { ...proposalBase, notARealField: true }));
  const result = parseDto(ResultProposalSchema, { ...proposalBase, notARealField: true });
  assert.equal(result.ok, false);
});

test("a proposal with a base revision requires a result revision", () => {
  assert.ok(!ResultProposalSchema.safeParse({ ...proposalBase, baseRevision: "base-1" }).success);
  assert.ok(
    ResultProposalSchema.safeParse({ ...proposalBase, baseRevision: "base-1", resultRevision: "result-1" }).success,
  );
});

const acceptanceBase = {
  kind: "acceptance",
  schemaVersion: 1,
  id: "acceptance-1",
  runId: "run-1",
  graphId: "graph-1",
  graphRevision: 1,
  nodeId: "implement",
  attemptId: "attempt-1",
  proposalDigest: "sha256:proposal",
  inputFingerprint: "sha256:inputs",
  decision: "accepted",
  checkReceiptIds: [] as string[],
  reviewReceiptIds: [] as string[],
  policyRevision: 1,
  decidedAt: new Date().toISOString(),
};

test("AT-08/AT-09: an accepted decision requires at least one check or review receipt", () => {
  assert.ok(!AcceptanceRecordSchema.safeParse(acceptanceBase).success);
  assert.ok(AcceptanceRecordSchema.safeParse({ ...acceptanceBase, checkReceiptIds: ["check-1"] }).success);
  assert.ok(AcceptanceRecordSchema.safeParse({ ...acceptanceBase, reviewReceiptIds: ["review-1"] }).success);
  assert.ok(AcceptanceRecordSchema.safeParse({ ...acceptanceBase, decision: "rejected" }).success);
});

const checkBase = {
  kind: "check",
  schemaVersion: 1,
  id: "check-1",
  runId: "run-1",
  attemptId: "attempt-1",
  profileId: "unit-tests",
  profileVersion: "sha256:profile",
  executable: "npm",
  args: ["test"],
  environmentDigest: "sha256:env",
  inputDigest: "sha256:input",
  sourceDigest: "sha256:source",
  exitCode: 0,
  outcome: "pass",
  logArtifactIds: [],
  startedAt: "2026-10-08T10:00:00.000Z",
  finishedAt: "2026-10-08T10:00:01.000Z",
};

const reviewBase = {
  kind: "review",
  schemaVersion: 1,
  id: "review-1",
  runId: "run-1",
  candidateDigest: "sha256:proposal",
  candidateAttemptId: "attempt-1",
  reviewerAttemptId: "attempt-2",
  verdicts: [{ criterion: "Done", verdict: "pass", evidenceIds: [] as string[] }],
  limitations: [] as string[],
};

test("every evidence kind parses through the discriminated union and nothing else does", () => {
  for (const record of [proposalBase, checkBase, reviewBase, { ...acceptanceBase, checkReceiptIds: ["check-1"] }]) {
    const parsed = parseDto(EvidenceRecordSchema, record);
    assert.ok(parsed.ok, JSON.stringify(record.kind));
  }
  assert.ok(!EvidenceRecordSchema.safeParse({ ...checkBase, kind: "receipt" }).success);
  assert.ok(CheckReceiptSchema.safeParse(checkBase).success);
  assert.ok(ReviewReceiptSchema.safeParse(reviewBase).success);
});

test("identifyEvidence derives the id from the content, ignoring any id already present", () => {
  const { id: _dropped, ...content } = checkBase;
  const identified = identifyEvidence<EvidenceRecord>(content as Omit<EvidenceRecord, "id">);
  assert.match(identified.id, /^sha256:[0-9a-f]{64}$/);
  const again = identifyEvidence<EvidenceRecord>({ ...checkBase, id: "whatever" } as EvidenceRecord);
  assert.equal(again.id, identified.id);
  const changed = identifyEvidence<EvidenceRecord>({ ...content, exitCode: 1, outcome: "fail" } as Omit<
    EvidenceRecord,
    "id"
  >);
  assert.notEqual(changed.id, identified.id);
  assert.ok(EvidenceRecordSchema.safeParse(identified).success);
});
