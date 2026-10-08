import type {
  AcceptanceDecision,
  CheckOutcome,
  EvidenceRecord,
  ReviewCriterionVerdict,
  TestCount,
} from "@auto-pi-lot/core";

export interface ProposalSummary {
  readonly id: string;
  readonly summary: string;
  readonly claims: readonly string[];
  readonly limitations: readonly string[];
  readonly baseRevision?: string;
  readonly resultRevision?: string;
}

export interface CheckSummary {
  readonly id: string;
  readonly profileId: string;
  readonly outcome: CheckOutcome;
  readonly exitCode: number | null;
  readonly testCount?: TestCount;
  readonly logArtifactIds: readonly string[];
}

export interface ReviewSummary {
  readonly id: string;
  readonly reviewerAttemptId: string;
  readonly verdicts: readonly ReviewCriterionVerdict[];
}

export interface AcceptanceSummary {
  readonly decision: AcceptanceDecision;
  readonly reasons?: readonly string[];
  readonly checkReceiptIds: readonly string[];
  readonly reviewReceiptIds: readonly string[];
}

export interface AttemptEvidence {
  readonly attemptId: string;
  readonly proposal?: ProposalSummary;
  readonly checks: readonly CheckSummary[];
  readonly reviews: readonly ReviewSummary[];
  readonly acceptance?: AcceptanceSummary;
}

/** Records for attempts no proposal or acceptance (and no `attemptNodes` entry) places on a node. */
export const UNATTRIBUTED_NODE = "(unattributed)";

export interface EvidenceSummaryOptions {
  /** Every node id of the run; each gets an entry, empty when it has no evidence. */
  readonly nodeIds?: readonly string[];
  /** Attempt id -> node id from the run state, for attempts whose records name no node. */
  readonly attemptNodes?: Readonly<Record<string, string>>;
}

interface Mutable {
  proposal?: ProposalSummary;
  checks: CheckSummary[];
  reviews: ReviewSummary[];
  acceptance?: { summary: AcceptanceSummary; decidedAt: string; id: string };
}

/**
 * Groups a run's evidence records by node and attempt. A check belongs to the attempt whose
 * workspace it ran against, a review to the producer attempt it judged, and only the latest
 * acceptance of an attempt is kept. Built from entries so a node id such as `__proto__` becomes
 * an own key, never a prototype write.
 */
export function summarizeEvidence(
  records: readonly EvidenceRecord[],
  options: EvidenceSummaryOptions = {},
): Record<string, AttemptEvidence[]> {
  const attempts = new Map<string, Mutable>();
  const nodeOf = new Map<string, string>(Object.entries(options.attemptNodes ?? {}));
  const slot = (attemptId: string): Mutable => {
    let found = attempts.get(attemptId);
    if (found === undefined) {
      found = { checks: [], reviews: [] };
      attempts.set(attemptId, found);
    }
    return found;
  };

  for (const record of records) {
    if (record.kind === "proposal" || record.kind === "acceptance") nodeOf.set(record.attemptId, record.nodeId);
  }
  for (const record of records) {
    switch (record.kind) {
      case "proposal":
        slot(record.attemptId).proposal = {
          id: record.id,
          summary: record.summary,
          claims: record.claims,
          limitations: record.limitations,
          ...(record.baseRevision === undefined ? {} : { baseRevision: record.baseRevision }),
          ...(record.resultRevision === undefined ? {} : { resultRevision: record.resultRevision }),
        };
        break;
      case "check":
        slot(record.attemptId).checks.push({
          id: record.id,
          profileId: record.profileId,
          outcome: record.outcome,
          exitCode: record.exitCode,
          ...(record.testCount === undefined ? {} : { testCount: record.testCount }),
          logArtifactIds: record.logArtifactIds,
        });
        break;
      case "review":
        slot(record.candidateAttemptId).reviews.push({
          id: record.id,
          reviewerAttemptId: record.reviewerAttemptId,
          verdicts: record.verdicts,
        });
        break;
      case "acceptance": {
        const target = slot(record.attemptId);
        const later =
          target.acceptance === undefined ||
          record.decidedAt > target.acceptance.decidedAt ||
          (record.decidedAt === target.acceptance.decidedAt && record.id > target.acceptance.id);
        if (later) {
          target.acceptance = {
            decidedAt: record.decidedAt,
            id: record.id,
            summary: {
              decision: record.decision,
              ...(record.reasons === undefined ? {} : { reasons: record.reasons }),
              checkReceiptIds: record.checkReceiptIds,
              reviewReceiptIds: record.reviewReceiptIds,
            },
          };
        }
        break;
      }
    }
  }

  const byNode = new Map<string, AttemptEvidence[]>((options.nodeIds ?? []).map((nodeId) => [nodeId, []]));
  for (const [attemptId, entry] of [...attempts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const nodeId = nodeOf.get(attemptId) ?? UNATTRIBUTED_NODE;
    const list = byNode.get(nodeId) ?? [];
    list.push({
      attemptId,
      ...(entry.proposal === undefined ? {} : { proposal: entry.proposal }),
      checks: entry.checks,
      reviews: entry.reviews,
      ...(entry.acceptance === undefined ? {} : { acceptance: entry.acceptance.summary }),
    });
    byNode.set(nodeId, list);
  }
  return Object.fromEntries(byNode);
}
