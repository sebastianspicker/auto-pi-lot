import assert from "node:assert/strict";
import test from "node:test";

import {
  type AcceptanceRecord,
  type AcceptanceRequest,
  type CheckReceipt,
  identifyEvidence,
  type NodeSpec,
  type ResultProposal,
  type ReviewReceipt,
} from "@auto-pi-lot/core";

import { EvidenceGate, MemoryEvidenceStore } from "../src/index.js";

const RUN = "run-1";
const NOW = new Date("2026-02-03T04:05:06.000Z");

function node(id: string, role: NodeSpec["role"], checks?: string[], criteria: string[] = ["c"]): NodeSpec {
  return {
    id,
    role,
    objective: "o",
    acceptanceCriteria: criteria,
    limits: { maxTokens: 1000, maxToolCalls: 10 },
    ...(checks === undefined ? {} : { checks }),
  };
}

function makeProposal(attemptId: string, extra: Partial<ResultProposal> = {}): ResultProposal {
  return identifyEvidence<ResultProposal>({
    kind: "proposal",
    schemaVersion: 1,
    runId: RUN,
    graphId: "g",
    graphRevision: 3,
    nodeId: "n",
    attemptId,
    summary: "s",
    outputArtifactIds: [],
    claims: [],
    limitations: [],
    requestedChecks: [],
    checkReceiptIds: [],

    inputFingerprint: "fp-1",
    resultRevision: "tree-1",
    ...extra,
  });
}

function makeCheck(attemptId: string, profileId: string, extra: Partial<CheckReceipt> = {}): CheckReceipt {
  return identifyEvidence<CheckReceipt>({
    kind: "check",
    schemaVersion: 1,
    runId: RUN,
    attemptId,
    profileId,
    profileVersion: "1",
    executable: "npm",
    args: ["test"],
    environmentDigest: "env",
    inputDigest: "in",
    sourceDigest: "tree-1",
    exitCode: 0,
    outcome: "pass",
    logArtifactIds: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    ...extra,
  });
}

function makeReview(
  candidateAttemptId: string,
  candidateDigest: string,
  reviewerAttemptId: string,
  verdicts: ReviewReceipt["verdicts"] = [{ criterion: "c", verdict: "pass", evidenceIds: [] }],
): ReviewReceipt {
  return identifyEvidence<ReviewReceipt>({
    kind: "review",
    schemaVersion: 1,
    runId: RUN,
    candidateDigest,
    candidateAttemptId,
    reviewerAttemptId,
    verdicts,
    limitations: [],
  });
}

function setup() {
  const evidence = new MemoryEvidenceStore();
  const gate = new EvidenceGate({ evidence, clock: () => NOW });
  return { evidence, gate };
}

/** The journaled map: attempt id -> proposal digest. */
function anchors(...proposals: ResultProposal[]): Record<string, string> {
  return Object.fromEntries(proposals.map((proposal) => [proposal.attemptId, proposal.id]));
}

/** A reviewer attempt's proposal naming the reviews it recorded. */
function reviewerProposal(attemptId: string, ...reviews: ReviewReceipt[]): ResultProposal {
  return makeProposal(attemptId, { outputArtifactIds: reviews.map((review) => review.id) });
}

function producerRequest(
  proposal: ResultProposal,
  checks?: string[],
  anchored: readonly ResultProposal[] = [],
): AcceptanceRequest {
  return {
    runId: RUN,
    nodeId: "n",
    attemptId: proposal.attemptId,
    node: node("n", "implementer", checks),
    proposalDigest: proposal.id,
    consumes: {},
    verifies: [],
    producers: [],
    proposalsByAttempt: anchors(proposal, ...anchored),
  };
}

function checkerRequest(
  proposal: ResultProposal,
  criteria: string[] = ["c"],
  others: ResultProposal[] = [],
): AcceptanceRequest {
  return {
    runId: RUN,
    nodeId: "v",
    attemptId: proposal.attemptId,
    node: node("v", "verifier"),
    proposalDigest: proposal.id,
    consumes: { n: "a1" },
    verifies: ["n"],
    producers: [node("n", "implementer", undefined, criteria)],
    proposalsByAttempt: anchors(proposal, ...others),
  };
}

async function acceptanceRecords(evidence: MemoryEvidenceStore): Promise<AcceptanceRecord[]> {
  return (await evidence.listForRun(RUN)).filter((r): r is AcceptanceRecord => r.kind === "acceptance");
}

test("a missing proposal record is rejected without throwing and stores nothing", async () => {
  const { evidence, gate } = setup();
  const proposal = makeProposal("a1");
  const verdict = await gate.evaluate(producerRequest(proposal));
  assert.deepEqual(verdict, {
    decision: "rejected",
    receiptIds: [],
    reasons: [`no proposal record ${proposal.id} for attempt a1`],
  });
  assert.deepEqual(await evidence.listForRun(RUN), []);
});

test("a producer with passing checks is accepted and the acceptance record is stored", async () => {
  const { evidence, gate } = setup();
  const unit = makeCheck("a1", "unit");
  const lint = makeCheck("a1", "lint");
  const proposal = makeProposal("a1", {
    resultRevision: "tree-1",
    baseRevision: "tree-0",
    checkReceiptIds: [unit.id, lint.id],
  });
  for (const record of [proposal, unit, lint]) await evidence.put(record);

  const verdict = await gate.evaluate(producerRequest(proposal, ["unit", "lint"]));
  assert.equal(verdict.decision, "accepted");
  assert.deepEqual(verdict.receiptIds, [unit.id, lint.id].sort());
  assert.equal("reasons" in verdict, false);

  const [record] = await acceptanceRecords(evidence);
  assert.ok(record);
  assert.equal(record.kind, "acceptance");
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.runId, RUN);
  assert.equal(record.graphId, "g");
  assert.equal(record.graphRevision, 3);
  assert.equal(record.nodeId, "n");
  assert.equal(record.attemptId, "a1");
  assert.equal(record.proposalDigest, proposal.id);
  assert.equal(record.inputFingerprint, "fp-1");
  assert.equal(record.decision, "accepted");
  assert.deepEqual(record.checkReceiptIds, [unit.id, lint.id].sort());
  assert.deepEqual(record.reviewReceiptIds, []);
  assert.equal(record.policyRevision, 1);
  assert.equal(record.decidedAt, NOW.toISOString());
  assert.equal("reasons" in record, false);
  assert.deepEqual(identifyEvidence<AcceptanceRecord>(record), record);
});

test("a failing check rejects and is cited", async () => {
  const { evidence, gate } = setup();
  const failing = makeCheck("a1", "unit", { outcome: "fail", exitCode: 1 });
  const proposal = makeProposal("a1", { checkReceiptIds: [failing.id] });
  await evidence.put(proposal);
  await evidence.put(failing);
  const verdict = await gate.evaluate(producerRequest(proposal, ["unit"]));
  assert.equal(verdict.decision, "rejected");
  assert.deepEqual(verdict.receiptIds, [failing.id]);
  assert.deepEqual(verdict.reasons, ["unit: fail (exit 1)"]);
  const [record] = await acceptanceRecords(evidence);
  assert.equal(record?.decision, "rejected");
  assert.deepEqual(record?.checkReceiptIds, [failing.id]);
});

test("a required check cannot accept a proposal without a source revision", async () => {
  const { evidence, gate } = setup();
  const check = makeCheck("a1", "unit");
  const { id: _id, resultRevision: _revision, ...content } = makeProposal("a1", { checkReceiptIds: [check.id] });
  const proposal = identifyEvidence<ResultProposal>(content);
  await evidence.put(proposal);
  await evidence.put(check);
  const verdict = await gate.evaluate(producerRequest(proposal, ["unit"]));
  assert.equal(verdict.decision, "rejected");
  assert.deepEqual(verdict.receiptIds, []);
});

test("only the latest referenced receipt per profile counts", async () => {
  const { evidence, gate } = setup();
  const old = makeCheck("a1", "unit", { outcome: "fail", exitCode: 1 });
  const fresh = makeCheck("a1", "unit", { finishedAt: "2026-01-01T00:00:09.000Z" });
  const proposal = makeProposal("a1", { checkReceiptIds: [old.id, fresh.id] });
  for (const record of [proposal, old, fresh]) await evidence.put(record);
  const verdict = await gate.evaluate(producerRequest(proposal, ["unit"]));
  assert.equal(verdict.decision, "accepted");
  assert.deepEqual(verdict.receiptIds, [fresh.id]);
});

test("a newer unreferenced failing receipt does not displace the referenced one", async () => {
  const { evidence, gate } = setup();
  const referenced = makeCheck("a1", "unit");
  const planted = makeCheck("a1", "unit", {
    outcome: "fail",
    exitCode: 1,
    finishedAt: "2026-01-01T00:00:09.000Z",
  });
  const proposal = makeProposal("a1", { checkReceiptIds: [referenced.id] });
  for (const record of [proposal, referenced, planted]) await evidence.put(record);
  const verdict = await gate.evaluate(producerRequest(proposal, ["unit"]));
  assert.equal(verdict.decision, "accepted");
  assert.deepEqual(verdict.receiptIds, [referenced.id]);
});

test("a missing required check rejects", async () => {
  const { evidence, gate } = setup();
  const unit = makeCheck("a1", "unit");
  const otherAttempt = makeCheck("a2", "lint");
  const proposal = makeProposal("a1", { checkReceiptIds: [unit.id, otherAttempt.id] });
  for (const record of [proposal, unit, otherAttempt]) await evidence.put(record);
  const verdict = await gate.evaluate(producerRequest(proposal, ["unit", "lint"]));
  assert.equal(verdict.decision, "rejected");
  assert.deepEqual(verdict.reasons, ["required check lint has no receipt for attempt a1"]);
});

test("a well-formed passing check receipt that no proposal references is ignored", async () => {
  const { evidence, gate } = setup();
  const planted = makeCheck("a1", "unit");
  const proposal = makeProposal("a1");
  for (const record of [proposal, planted]) await evidence.put(record);
  const verdict = await gate.evaluate(producerRequest(proposal, ["unit"]));
  assert.equal(verdict.decision, "rejected");
  assert.deepEqual(verdict.receiptIds, []);
  assert.deepEqual(verdict.reasons, ["required check unit has no receipt for attempt a1"]);
});

test("a receipt for a different tree does not count", async () => {
  const { evidence, gate } = setup();
  const stale = makeCheck("a1", "unit", { sourceDigest: "tree-1" });
  const proposal = makeProposal("a1", {
    resultRevision: "tree-2",
    baseRevision: "tree-0",
    checkReceiptIds: [stale.id],
  });
  await evidence.put(proposal);
  await evidence.put(stale);
  const verdict = await gate.evaluate(producerRequest(proposal, ["unit"]));
  assert.equal(verdict.decision, "rejected");
  assert.deepEqual(verdict.receiptIds, []);
  assert.deepEqual(verdict.reasons, [`receipt ${stale.id} checked tree tree-1, proposal is tree-2`]);
});

test("a failing review rejects the producer and is cited", async () => {
  const { evidence, gate } = setup();
  const unit = makeCheck("a1", "unit");
  const proposal = makeProposal("a1", { checkReceiptIds: [unit.id] });
  const bad = makeReview("a1", proposal.id, "r1", [
    { criterion: "c", verdict: "pass", evidenceIds: [] },
    { criterion: "handles errors", verdict: "fail", evidenceIds: [], note: "swallows them" },
  ]);
  const reviewer = reviewerProposal("r1", bad);
  for (const record of [proposal, unit, bad, reviewer]) await evidence.put(record);
  const base = producerRequest(proposal, ["unit"], [reviewer]);
  const request = { ...base, node: { ...base.node, acceptanceCriteria: ["c", "handles errors"] } };
  const verdict = await gate.evaluate(request);
  assert.equal(verdict.decision, "rejected");
  assert.deepEqual(verdict.receiptIds, [unit.id, bad.id].sort());
  assert.deepEqual(verdict.reasons, ["r1: handles errors failed: swallows them"]);
});

test("a producer with no checks is accepted on a passing review bound to its digest", async () => {
  const { evidence, gate } = setup();
  const proposal = makeProposal("a1");
  const good = makeReview("a1", proposal.id, "r1");
  const wrongDigest = makeReview("a1", "other-digest", "r2", [{ criterion: "c", verdict: "fail", evidenceIds: [] }]);
  const r1 = reviewerProposal("r1", good);
  const r2 = reviewerProposal("r2", wrongDigest);
  for (const record of [proposal, good, wrongDigest, r1, r2]) await evidence.put(record);
  const verdict = await gate.evaluate(producerRequest(proposal, undefined, [r1, r2]));
  assert.equal(verdict.decision, "accepted");
  assert.deepEqual(verdict.receiptIds, [good.id]);
  const [record] = await acceptanceRecords(evidence);
  assert.deepEqual(record?.reviewReceiptIds, [good.id]);
  assert.deepEqual(record?.checkReceiptIds, []);
});

test("a passing review that no anchored proposal references is ignored", async () => {
  const { evidence, gate } = setup();
  const proposal = makeProposal("a1");
  const planted = makeReview("a1", proposal.id, "r1");
  const unlisted = makeReview("a1", proposal.id, "r2");
  const r1 = reviewerProposal("r1"); // anchored, but does not name the review
  const r2 = reviewerProposal("r2", unlisted); // names the review, but is not journaled
  for (const record of [proposal, planted, unlisted, r1, r2]) await evidence.put(record);
  const verdict = await gate.evaluate(producerRequest(proposal, undefined, [r1]));
  assert.deepEqual(verdict, {
    decision: "rejected",
    receiptIds: [],
    reasons: ["no evidence: node declares no checks and no verifying node reviewed attempt a1"],
  });
});

test("a planted failing review does not reject a producer with passing checks", async () => {
  const { evidence, gate } = setup();
  const unit = makeCheck("a1", "unit");
  const proposal = makeProposal("a1", { checkReceiptIds: [unit.id] });
  const planted = makeReview("a1", proposal.id, "r1", [{ criterion: "c", verdict: "fail", evidenceIds: [] }]);
  for (const record of [proposal, unit, planted]) await evidence.put(record);
  const verdict = await gate.evaluate(producerRequest(proposal, ["unit"]));
  assert.equal(verdict.decision, "accepted");
  assert.deepEqual(verdict.receiptIds, [unit.id]);
});

test("an anchored proposal record with another digest is not trusted", async () => {
  const { evidence, gate } = setup();
  const proposal = makeProposal("a1");
  const review = makeReview("a1", proposal.id, "r1");
  const reviewer = reviewerProposal("r1", review);
  for (const record of [proposal, review, reviewer]) await evidence.put(record);
  const base = producerRequest(proposal);
  const request = { ...base, proposalsByAttempt: { ...base.proposalsByAttempt, r1: "sha256:somethingelse" } };
  const verdict = await gate.evaluate(request);
  assert.equal(verdict.decision, "rejected");
  assert.deepEqual(verdict.receiptIds, []);
});

test("a producer ignores a bound review that skips one of its acceptance criteria", async () => {
  const { evidence, gate } = setup();
  const unit = makeCheck("a1", "unit");
  const proposal = makeProposal("a1", { checkReceiptIds: [unit.id] });
  const partial = makeReview("a1", proposal.id, "r1", [{ criterion: "invented", verdict: "fail", evidenceIds: [] }]);
  const reviewer = reviewerProposal("r1", partial);
  for (const record of [proposal, unit, partial, reviewer]) await evidence.put(record);
  const verdict = await gate.evaluate(producerRequest(proposal, ["unit"], [reviewer]));
  assert.deepEqual(verdict, { decision: "accepted", receiptIds: [unit.id] });
  const [record] = await acceptanceRecords(evidence);
  assert.deepEqual(record?.reviewReceiptIds, []);
});

test("a producer with no checks and no review is rejected for lack of evidence", async () => {
  const { evidence, gate } = setup();
  const proposal = makeProposal("a1");
  await evidence.put(proposal);
  const verdict = await gate.evaluate(producerRequest(proposal));
  assert.deepEqual(verdict, {
    decision: "rejected",
    receiptIds: [],
    reasons: ["no evidence: node declares no checks and no verifying node reviewed attempt a1"],
  });
  assert.equal((await acceptanceRecords(evidence)).length, 1);
});

test("an unclear review neither counts nor rejects the producer", async () => {
  const { evidence, gate } = setup();
  const proposal = makeProposal("a1");
  const unclear = makeReview("a1", proposal.id, "r1", [{ criterion: "c", verdict: "unclear", evidenceIds: [] }]);
  const reviewer = reviewerProposal("r1", unclear);
  for (const record of [proposal, unclear, reviewer]) await evidence.put(record);
  const verdict = await gate.evaluate(producerRequest(proposal, undefined, [reviewer]));
  assert.equal(verdict.decision, "rejected");
  assert.deepEqual(verdict.receiptIds, []);
});

test("receipts are truncated to 64 with a reason", async () => {
  const { evidence, gate } = setup();
  const profiles = Array.from({ length: 64 }, (_, index) => `p${index}`);
  const receipts = profiles.map((profile) => makeCheck("a1", profile));
  const proposal = makeProposal("a1", { checkReceiptIds: receipts.map((receipt) => receipt.id) });
  const good = makeReview("a1", proposal.id, "r1");
  const reviewer = reviewerProposal("r1", good);
  for (const record of [proposal, good, reviewer, ...receipts]) await evidence.put(record);
  const verdict = await gate.evaluate(producerRequest(proposal, profiles, [reviewer]));
  assert.equal(verdict.decision, "accepted");
  assert.deepEqual(verdict.receiptIds, [...receipts.map((r) => r.id), good.id].sort().slice(0, 64));
  assert.deepEqual(verdict.reasons, ["receipts truncated to the first 64 by id"]);
  const [record] = await acceptanceRecords(evidence);
  assert.equal((record?.checkReceiptIds.length ?? 0) + (record?.reviewReceiptIds.length ?? 0), 64);
});

test("a checker with a valid passing review is accepted", async () => {
  const { evidence, gate } = setup();
  const mine = makeReview("a1", "d", "v1");
  const otherChecker = makeReview("a1", "d", "v2", [{ criterion: "c", verdict: "fail", evidenceIds: [] }]);
  const proposal = reviewerProposal("v1", mine);
  const other = reviewerProposal("v2", otherChecker);
  for (const record of [proposal, other, mine, otherChecker]) await evidence.put(record);
  const verdict = await gate.evaluate(checkerRequest(proposal, ["c"], [other]));
  assert.deepEqual(verdict, { decision: "accepted", receiptIds: [mine.id] });
  const [record] = await acceptanceRecords(evidence);
  assert.deepEqual(record?.reviewReceiptIds, [mine.id]);
});

test("a failing review does not reject the checker itself", async () => {
  const { evidence, gate } = setup();
  const failing = makeReview("a1", "d", "v1", [{ criterion: "c", verdict: "fail", evidenceIds: [] }]);
  const proposal = reviewerProposal("v1", failing);
  for (const record of [proposal, failing]) await evidence.put(record);
  const verdict = await gate.evaluate(checkerRequest(proposal));
  assert.equal(verdict.decision, "accepted");
  assert.deepEqual(verdict.receiptIds, [failing.id]);
});

test("a checker without a review of its candidate is rejected", async () => {
  const { evidence, gate } = setup();
  const wrongCandidate = makeReview("a9", "d", "v1");
  const proposal = reviewerProposal("v1", wrongCandidate);
  for (const record of [proposal, wrongCandidate]) await evidence.put(record);
  const verdict = await gate.evaluate(checkerRequest(proposal));
  assert.deepEqual(verdict, {
    decision: "rejected",
    receiptIds: [],
    reasons: ["checker v stored no review of its candidate"],
  });
});

test("a checker whose review exists but is not named by its proposal is rejected", async () => {
  const { evidence, gate } = setup();
  const planted = makeReview("a1", "d", "v1");
  const proposal = makeProposal("v1");
  for (const record of [proposal, planted]) await evidence.put(record);
  const verdict = await gate.evaluate(checkerRequest(proposal));
  assert.deepEqual(verdict, {
    decision: "rejected",
    receiptIds: [],
    reasons: ["checker v stored no review of its candidate"],
  });
});

test("a checker whose review leaves criteria unclear is rejected citing the review", async () => {
  const { evidence, gate } = setup();
  const unclear = makeReview("a1", "d", "v1", [
    { criterion: "c1", verdict: "unclear", evidenceIds: [] },
    { criterion: "c2", verdict: "unclear", evidenceIds: [] },
    { criterion: "c3", verdict: "pass", evidenceIds: [] },
  ]);
  const proposal = reviewerProposal("v1", unclear);
  for (const record of [proposal, unclear]) await evidence.put(record);
  const verdict = await gate.evaluate(checkerRequest(proposal, ["c1", "c2", "c3"]));
  assert.equal(verdict.decision, "rejected");
  assert.deepEqual(verdict.receiptIds, [unclear.id]);
  assert.deepEqual(verdict.reasons, [`review ${unclear.id} left 2 criteria unclear; a fresh review is needed`]);
});

test("a checker whose review skips an acceptance criterion is rejected citing the review", async () => {
  const { evidence, gate } = setup();
  const partial = makeReview("a1", "d", "v1", [
    { criterion: "c1", verdict: "pass", evidenceIds: [] },
    { criterion: "something invented", verdict: "pass", evidenceIds: [] },
  ]);
  const proposal = reviewerProposal("v1", partial);
  for (const record of [proposal, partial]) await evidence.put(record);
  const verdict = await gate.evaluate(checkerRequest(proposal, ["c1", " c2 "]));
  assert.equal(verdict.decision, "rejected");
  assert.deepEqual(verdict.receiptIds, [partial.id]);
  assert.deepEqual(verdict.reasons, [`review ${partial.id} does not judge every acceptance criterion: missing c2`]);
});

test("a consumes map with a __proto__ producer id does not confuse the checker lookup", async () => {
  const { evidence, gate } = setup();
  const proposal = makeProposal("v1");
  await evidence.put(proposal);
  const consumes = JSON.parse('{"__proto__": "a1"}') as Record<string, string>;
  const verdict = await gate.evaluate({ ...checkerRequest(proposal), consumes, verifies: ["__proto__"] });
  assert.equal(verdict.decision, "rejected");
});
