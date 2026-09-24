import assert from "node:assert/strict";
import test from "node:test";

import { AcceptanceRecordSchema, parseDto, ResultProposalSchema } from "../src/index.js";

const proposalBase = {
  schemaVersion: 1,
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
  schemaVersion: 1,
  id: "acceptance-1",
  runId: "run-1",
  graphId: "graph-1",
  graphRevision: 1,
  nodeId: "implement",
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
