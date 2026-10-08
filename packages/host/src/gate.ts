import {
  type AcceptanceGate,
  type AcceptanceRecord,
  type AcceptanceRequest,
  type AcceptanceVerdict,
  type CheckReceipt,
  type EvidenceStore,
  identifyEvidence,
  isCheckerRole,
  type ResultProposal,
  type ReviewReceipt,
} from "@auto-pi-lot/core";

export interface EvidenceGateOptions {
  readonly evidence: EvidenceStore;
  readonly clock?: () => Date;
}

const MAX_RECEIPTS = 64;
const MAX_REASONS = 32;
const MAX_REASON_CHARS = 2000;

function byId(a: { readonly id: string }, b: { readonly id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Later `finishedAt` wins; equal times fall back to the larger id, so the choice is deterministic. */
function newer(a: CheckReceipt, b: CheckReceipt): boolean {
  const left = Date.parse(a.finishedAt);
  const right = Date.parse(b.finishedAt);
  return left !== right ? left > right : a.id > b.id;
}

/**
 * Decides acceptance from recorded evidence only. It never runs a check, starts a worker or
 * calls a model: the receipts it cites must already be in the evidence store, put there by the
 * host-side worker that ran the checks or recorded the review. Every decision, accepted or
 * rejected, is stored as an `AcceptanceRecord` when the attempt has a proposal record to take
 * its graph identity from.
 *
 * Trust anchor: the store sits in the workspace, where a model with file tools could write a
 * well-formed record. So nothing counts because it is in the store. A record counts only when it
 * is reachable from a proposal digest the host journaled (`request.proposalsByAttempt`): a check
 * receipt must be named in the proposal's `checkReceiptIds`, a review must be named in the
 * reviewing attempt's proposal `outputArtifactIds`. Proposals are built by host code after the
 * session ended and their digest travels in memory to the journal, so a planted record with the
 * same id would have the same content and a planted one with other content is unreachable.
 *
 * - A checker node (verifier, falsifier, reviewer) is accepted when its own proposal names a
 *   review of the candidate it verifies, with one verdict per acceptance criterion of that
 *   candidate's producer and none unclear. A failing review does not reject the checker; it
 *   rejects the producer.
 * - A producer node is accepted when every check profile the node requires has a passing,
 *   referenced receipt against the proposal's result revision and no referenced review of this
 *   candidate failed. One review suffices; there is no two-review agreement yet.
 */
export class EvidenceGate implements AcceptanceGate {
  readonly #evidence: EvidenceStore;
  readonly #clock: () => Date;

  constructor(options: EvidenceGateOptions) {
    this.#evidence = options.evidence;
    this.#clock = options.clock ?? (() => new Date());
  }

  async evaluate(request: AcceptanceRequest): Promise<AcceptanceVerdict> {
    const records = await this.#evidence.listForRun(request.runId);
    const proposal = records.find(
      (record): record is ResultProposal => record.kind === "proposal" && record.id === request.proposalDigest,
    );
    if (proposal === undefined) {
      return {
        decision: "rejected",
        receiptIds: [],
        reasons: [`no proposal record ${request.proposalDigest} for attempt ${request.attemptId}`],
      };
    }
    // Only records a journal-anchored proposal names are evidence.
    const proposals = new Map<string, ResultProposal>();
    for (const record of records) if (record.kind === "proposal") proposals.set(record.id, record);
    const anchored = new Map<string, ResultProposal>(); // attempt id -> its journaled proposal record
    for (const [attemptId, digest] of Object.entries(request.proposalsByAttempt)) {
      const record = proposals.get(digest);
      if (record !== undefined && record.attemptId === attemptId) anchored.set(attemptId, record);
    }
    const referencedReviews = new Set<string>();
    for (const record of anchored.values()) for (const id of record.outputArtifactIds) referencedReviews.add(id);
    const reviews = records.filter(
      (record): record is ReviewReceipt =>
        record.kind === "review" && referencedReviews.has(record.id) && anchored.has(record.reviewerAttemptId),
    );
    const checks = records.filter(
      (record): record is CheckReceipt => record.kind === "check" && proposal.checkReceiptIds.includes(record.id),
    );
    const outcome = isCheckerRole(request.node.role)
      ? this.#judgeChecker(request, reviews)
      : this.#judgeProducer(request, proposal, checks, reviews);

    const reasons = [...outcome.reasons];
    let checkIds = [...new Set(outcome.checkIds)].sort();
    let reviewIds = [...new Set(outcome.reviewIds)].sort();
    if (checkIds.length + reviewIds.length > MAX_RECEIPTS) {
      const kept = new Set([...checkIds, ...reviewIds].sort().slice(0, MAX_RECEIPTS));
      checkIds = checkIds.filter((id) => kept.has(id));
      reviewIds = reviewIds.filter((id) => kept.has(id));
      reasons.push(`receipts truncated to the first ${MAX_RECEIPTS} by id`);
    }
    const receiptIds = [...checkIds, ...reviewIds].sort();
    const clipped = reasons.slice(0, MAX_REASONS).map((reason) => reason.slice(0, MAX_REASON_CHARS));

    const record = identifyEvidence<AcceptanceRecord>({
      kind: "acceptance",
      schemaVersion: 1,
      runId: request.runId,
      graphId: proposal.graphId,
      graphRevision: proposal.graphRevision,
      nodeId: request.nodeId,
      attemptId: request.attemptId,
      proposalDigest: request.proposalDigest,
      inputFingerprint: proposal.inputFingerprint,
      decision: outcome.decision,
      checkReceiptIds: checkIds,
      reviewReceiptIds: reviewIds,
      policyRevision: 1,
      decidedAt: this.#clock().toISOString(),
      ...(clipped.length > 0 ? { reasons: clipped } : {}),
    });
    await this.#evidence.put(record);
    return { decision: outcome.decision, receiptIds, ...(clipped.length > 0 ? { reasons: clipped } : {}) };
  }

  #judgeChecker(request: AcceptanceRequest, reviews: readonly ReviewReceipt[]): Outcome {
    const candidates = new Set(
      request.verifies.flatMap((producer) =>
        Object.hasOwn(request.consumes, producer) ? [request.consumes[producer] as string] : [],
      ),
    );
    const valid = reviews
      .filter((review) => review.reviewerAttemptId === request.attemptId && candidates.has(review.candidateAttemptId))
      .sort(byId);
    if (valid.length === 0) {
      return {
        decision: "rejected",
        checkIds: [],
        reviewIds: [],
        reasons: [`checker ${request.nodeId} stored no review of its candidate`],
      };
    }
    // One verdict per acceptance criterion of the candidate's producer: an invented criterion is
    // not a review of the candidate (decision 0010, item 4).
    const uncovered = valid.flatMap((review) => {
      const producer = request.producers.find(
        (spec) => request.verifies.includes(spec.id) && request.consumes[spec.id] === review.candidateAttemptId,
      );
      if (producer === undefined) return [{ id: review.id, missing: ["(unknown producer)"] }];
      const missing = criteriaMissing(producer.acceptanceCriteria, review);
      return missing.length > 0 ? [{ id: review.id, missing }] : [];
    });
    if (uncovered.length > 0) {
      return {
        decision: "rejected",
        checkIds: [],
        reviewIds: uncovered.map((entry) => entry.id),
        reasons: uncovered.map(
          (entry) =>
            `review ${entry.id} does not judge every acceptance criterion: missing ${entry.missing.join("; ")}`,
        ),
      };
    }
    const unclear = valid.flatMap((review) => {
      const count = review.verdicts.filter((verdict) => verdict.verdict === "unclear").length;
      return count > 0 ? [{ id: review.id, count }] : [];
    });
    if (unclear.length > 0) {
      return {
        decision: "rejected",
        checkIds: [],
        reviewIds: unclear.map((entry) => entry.id),
        reasons: unclear.map(
          (entry) =>
            `review ${entry.id} left ${entry.count} ${entry.count === 1 ? "criterion" : "criteria"} unclear; a fresh review is needed`,
        ),
      };
    }
    return { decision: "accepted", checkIds: [], reviewIds: valid.map((review) => review.id), reasons: [] };
  }

  #judgeProducer(
    request: AcceptanceRequest,
    proposal: ResultProposal,
    checks: readonly CheckReceipt[],
    reviews: readonly ReviewReceipt[],
  ): Outcome {
    const reasons: string[] = [];
    const checkIds: string[] = [];
    const reviewIds: string[] = [];
    let failed = false;

    const mine = checks.filter((check) => check.attemptId === request.attemptId);
    for (const profile of new Set(request.node.checks ?? [])) {
      let latest: CheckReceipt | undefined;
      for (const check of mine) {
        if (check.profileId === profile && (latest === undefined || newer(check, latest))) latest = check;
      }
      if (latest === undefined) {
        failed = true;
        reasons.push(`required check ${profile} has no receipt for attempt ${request.attemptId}`);
        continue;
      }
      if (proposal.resultRevision === undefined || latest.sourceDigest !== proposal.resultRevision) {
        failed = true;
        reasons.push(
          `receipt ${latest.id} checked tree ${latest.sourceDigest}, proposal is ${proposal.resultRevision}`,
        );
        continue;
      }
      checkIds.push(latest.id);
      if (latest.outcome !== "pass") {
        failed = true;
        reasons.push(`${profile}: ${latest.outcome} (exit ${latest.exitCode === null ? "none" : latest.exitCode})`);
      }
    }

    const passingChecks = new Set(
      mine.filter((check) => checkIds.includes(check.id) && check.outcome === "pass").map((c) => c.id),
    );
    const bound = reviews
      .filter(
        (review) =>
          review.candidateAttemptId === request.attemptId && review.candidateDigest === request.proposalDigest,
      )
      .sort(byId);
    const countedReviews: string[] = [];
    for (const review of bound) {
      // A review that skips a criterion of this node is not a review of it.
      if (criteriaMissing(request.node.acceptanceCriteria, review).length > 0) continue;
      const failing = review.verdicts.filter((verdict) => verdict.verdict === "fail");
      if (failing.length > 0) {
        failed = true;
        reviewIds.push(review.id);
        for (const verdict of failing) {
          reasons.push(
            `${review.reviewerAttemptId}: ${verdict.criterion} failed${verdict.note === undefined ? "" : `: ${verdict.note}`}`,
          );
        }
      } else if (review.verdicts.every((verdict) => verdict.verdict === "pass")) {
        countedReviews.push(review.id);
      }
    }

    if (failed) {
      // Cite what was counted, so the rejection is tied to its receipts.
      return { decision: "rejected", checkIds, reviewIds, reasons };
    }
    if (passingChecks.size === 0 && countedReviews.length === 0) {
      return {
        decision: "rejected",
        checkIds: [],
        reviewIds: [],
        reasons: [`no evidence: node declares no checks and no verifying node reviewed attempt ${request.attemptId}`],
      };
    }
    return { decision: "accepted", checkIds: [...passingChecks], reviewIds: countedReviews, reasons };
  }
}

/** The producer's acceptance criteria that `review` has no verdict for (exact text after trimming). */
export function criteriaMissing(criteria: readonly string[], review: ReviewReceipt): string[] {
  const judged = new Set(review.verdicts.map((verdict) => verdict.criterion.trim()));
  return criteria.map((criterion) => criterion.trim()).filter((criterion) => !judged.has(criterion));
}

interface Outcome {
  readonly decision: "accepted" | "rejected";
  readonly checkIds: readonly string[];
  readonly reviewIds: readonly string[];
  readonly reasons: readonly string[];
}
