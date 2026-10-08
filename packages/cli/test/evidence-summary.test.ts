import assert from "node:assert/strict";
import test from "node:test";

import {
  type AcceptanceRecord,
  type CheckReceipt,
  identifyEvidence,
  type ResultProposal,
  type ReviewReceipt,
} from "@auto-pi-lot/core";
import { MemoryEvidenceStore } from "@auto-pi-lot/host";

import { summarizeEvidence, UNATTRIBUTED_NODE } from "../src/evidence-summary.js";

const base = { schemaVersion: 1 as const, runId: "run-1" };
const AT = "2026-01-01T00:00:00.000Z";

const proposal = (nodeId: string, attemptId: string, extra: Partial<ResultProposal> = {}) =>
  identifyEvidence<ResultProposal>({
    ...base,
    kind: "proposal",
    graphId: "g",
    graphRevision: 1,
    nodeId,
    attemptId,
    summary: `done ${attemptId}`,
    outputArtifactIds: [],
    claims: ["works"],
    limitations: [],
    requestedChecks: [],
    checkReceiptIds: [],

    inputFingerprint: "fp",
    ...extra,
  });

const check = (attemptId: string, profileId: string) =>
  identifyEvidence<CheckReceipt>({
    ...base,
    kind: "check",
    attemptId,
    profileId,
    profileVersion: "v1",
    executable: "npm",
    args: ["run", profileId],
    environmentDigest: "env",
    inputDigest: "in",
    sourceDigest: "src",
    exitCode: 0,
    outcome: "pass",
    logArtifactIds: ["sha256:aa"],
    startedAt: AT,
    finishedAt: AT,
  });

const review = (candidateAttemptId: string, reviewerAttemptId: string) =>
  identifyEvidence<ReviewReceipt>({
    ...base,
    kind: "review",
    candidateDigest: "sha256:cand",
    candidateAttemptId,
    reviewerAttemptId,
    verdicts: [{ criterion: "c", verdict: "pass", evidenceIds: [] }],
    limitations: [],
  });

const acceptance = (
  nodeId: string,
  attemptId: string,
  decision: "accepted" | "rejected",
  decidedAt: string,
  checkId: string,
) =>
  identifyEvidence<AcceptanceRecord>({
    ...base,
    kind: "acceptance",
    graphId: "g",
    graphRevision: 1,
    nodeId,
    attemptId,
    proposalDigest: "sha256:p",
    inputFingerprint: "fp",
    decision,
    checkReceiptIds: [checkId],
    reviewReceiptIds: [],
    policyRevision: 1,
    decidedAt,
  });

test("evidence is grouped by node and attempt, keeping the latest acceptance", async () => {
  const store = new MemoryEvidenceStore();
  const p = proposal("implement", "att-1", { baseRevision: "a", resultRevision: "b" });
  const c = check("att-1", "test");
  const r = review("att-1", "att-2");
  const early = acceptance("implement", "att-1", "rejected", "2026-01-01T00:00:00.000Z", c.id);
  const late = acceptance("implement", "att-1", "accepted", "2026-01-01T00:00:05.000Z", c.id);
  for (const record of [p, c, r, early, late, proposal("other", "att-3")]) await store.put(record);

  const summary = summarizeEvidence(await store.listForRun("run-1"), { nodeIds: ["implement", "other", "idle"] });
  assert.deepEqual(Object.keys(summary).sort(), ["idle", "implement", "other"]);
  assert.deepEqual(summary.idle, []);
  const [attempt] = summary.implement ?? [];
  assert.equal(attempt?.attemptId, "att-1");
  assert.equal(attempt?.proposal?.resultRevision, "b");
  assert.deepEqual(
    attempt?.checks.map((entry) => entry.profileId),
    ["test"],
  );
  assert.deepEqual(
    attempt?.reviews.map((entry) => entry.reviewerAttemptId),
    ["att-2"],
  );
  assert.equal(attempt?.acceptance?.decision, "accepted");
  const [other] = summary.other ?? [];
  assert.equal(other?.proposal?.baseRevision, undefined);
  assert.equal("baseRevision" in (other?.proposal ?? {}), false);
});

test("a node id such as __proto__ becomes an own key and unplaced attempts are kept", () => {
  const summary = summarizeEvidence([proposal("__proto__", "att-1"), check("att-9", "lint")], {
    nodeIds: ["__proto__"],
    attemptNodes: {},
  });
  assert.equal(Object.hasOwn(summary, "__proto__"), true);
  assert.equal(Object.entries(summary).find(([key]) => key === "__proto__")?.[1]?.[0]?.attemptId, "att-1");
  assert.equal(Object.getPrototypeOf(summary), Object.prototype);
  assert.equal(summary[UNATTRIBUTED_NODE]?.[0]?.attemptId, "att-9");
});
