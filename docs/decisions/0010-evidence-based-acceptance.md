# 0010 — Acceptance is decided from recorded evidence; checks run inside the attempt

Accepted 2026-10-08. Implements the host-policy part of [decision 0005](0005-producer-targeted-repair.md)
(items 4 and 9) that [decision 0007](0007-verification-gates-acceptance.md) left to the host, and
supersedes that record's closing paragraph ("Host policy, not reducer logic"). Work packages:
AP-12 (check receipts, review, acceptance), AP-11 (running configured checks).

## Context

Until now the only acceptance gate was scripted: `ScriptedGate` answered every
`evaluate_acceptance` with whatever a test told it to. The contracts for check receipts, review
receipts and acceptance records existed in `core`, but nothing produced or read them, so the
host could not run a real plan. The product needs one rule for turning what actually happened
(a check's exit status, a reviewer's verdict) into the reducer's `acceptance_decided` event,
with the evidence tied to the exact tree it was about.

## Decision

1. **Evidence records have a kind and an identity.** `ResultProposal`, `CheckReceipt`,
   `ReviewReceipt` and `AcceptanceRecord` carry `kind` and form `EvidenceRecordSchema`. A record's
   `id` is the digest of its content without the id (`identifyEvidence`), so the same record
   always has the same id and no record can change without changing its id. Check receipts carry
   `runId` and `attemptId`; review receipts carry `runId`, `candidateAttemptId` and
   `candidateDigest`; acceptance records carry `attemptId` and optional `reasons`. The
   `proposalDigest` on a `result_proposed` event is the id of the proposal record.
2. **Two new ports in `core`, implemented in `host`.** `EvidenceStore` (`put`, `get`,
   `listForRun`) and `ArtifactStore` (`put(bytes)`, `get(id)`), both immutable and
   content-addressed. `host` ships memory and file implementations (`.auto-pi-lot/evidence/`,
   `.auto-pi-lot/artifacts/`), atomic writes, hash verified on read.
3. **Checks run inside the attempt, by host code.** A node names the check profiles it must pass
   (`NodeSpec.checks`); profiles are operator configuration (`CheckProfileSchema`: executable,
   argument list, directory inside the workspace, timeout). The worker runs them after the
   session has settled and while the attempt still holds the workspace, records one
   `CheckReceipt` per profile with the outcome taken from the real exit status, the log as an
   artifact and `sourceDigest` equal to the workspace fingerprint the proposal records as
   `resultRevision`. A model never runs a check on the host's behalf and cannot write a receipt.
4. **A checker's result is its review.** A verifier, falsifier or reviewer attempt reviews
   exactly one candidate: the proposal of the producer it reaches through its `result_ready`
   edge. Its final message must carry one verdict per acceptance criterion of that producer;
   the worker records it as a `ReviewReceipt` bound to the candidate's attempt and digest.
5. **The gate judges records only, and only anchored ones.** `EvidenceGate` answers
   `evaluate_acceptance` from the run's evidence store and never runs anything. The store sits
   in the workspace, where a session with file tools could write a well-formed record, so being
   in the store makes nothing evidence. The host hands the gate the proposal digest it journaled
   for every attempt (`proposalsByAttempt`); a check receipt counts only when the producer's
   journaled proposal names it in `checkReceiptIds`, and a review only when the reviewing
   attempt's journaled proposal names it in `outputArtifactIds`. Proposals are built by host code
   after the session has ended and their digest travels in memory to the journal, so a planted
   record either has the same content (harmless) or is unreachable. Then:
   - a checker attempt is accepted when it stored a review of its candidate that judges every
     acceptance criterion of the candidate's producer (the worker refuses a report that skips
     one, after one repair prompt) with no `unclear` verdict; an `unclear` verdict rejects the
     *checker's* attempt, so the reducer retries it with the review as `repairOf`, which is
     decision 0005's "fresh independent review";
   - a producer attempt is accepted when every required profile has a passing receipt for this
     attempt against the proposal's `resultRevision` and no review bound to this candidate has a
     `fail` verdict; a failing check or review rejects it, citing the receipts;
   - an attempt with no counted evidence is rejected: an acceptance must cite a receipt
     (decision 0006), and a model's own report is not one;
   - every decision is stored as an `AcceptanceRecord` with its reasons.
6. **Graph lint follows.** A non-checker node without declared checks and without a verifying
   node is `unverified_producer`; a checker with declared checks or with more than one candidate
   is warned. The `run` command refuses such a graph for real workers unless told otherwise.

Deliberate deviations from decision 0005:

- **No two-review agreement, no counterexample-as-check.** One review suffices, and a failing
  review rejects the producer on its own. Review agreement and turning a falsifier's
  counterexample into a required check remain open (AP-12).
- **A model's `fail` rejects the producer.** Decision 0005 wanted only reproducible check
  failures to reject on their own. Here a reviewer's `fail` does too, because the reviewer
  cites evidence per criterion and the producer gets the receipt as `repairOf`; the cost of a
  wrong `fail` is one bounded repair attempt.

## Consequences

- `SCHEMA_VERSION` stays 1: evidence records are new data, and the journal events are unchanged.
  Evidence test vectors change shape; no earlier evidence store existed.
- `AcceptanceRequest` gains `consumes`, `verifies`, `producers` and `proposalsByAttempt`;
  `WorkerAssignment` gains `graphId`, `graphRevision`, `verifies` and `producers`;
  `ResultProposal` gains `checkReceiptIds`; `AcceptanceVerdict` gains optional `reasons`.
- Checker sessions are opened without the repository's context files (a producer could have
  written them to steer its reviewer), and every model-authored string in a task packet is
  inside a fenced block labelled as data.
- A receipt's `sourceDigest` must match the proposal's `resultRevision`, so evidence about a
  tree that changed after the attempt cannot be counted. This is what makes the one-workspace
  rule of [decision 0011](0011-one-workspace-serialised-writers.md) safe.
- The gate's `reasons` and the stored acceptance record are for operators (`inspect`); the
  reducer still sees only `decision` and `receiptIds`.
