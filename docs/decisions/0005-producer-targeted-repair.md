# 0005 — Verification findings repair the producer and invalidate its consumers

Accepted 2026-09-26. Work packages: AP-12 (acceptance gate), AP-17 (repair and invalidation).
Not implemented yet.

## Context

A graph such as `implement → check → review` exists to find defects in `implement`'s result.
The reducer cannot yet act on such a finding:

- A rejecting `acceptance_decided` retries the node it names (`decide.ts`, rejection branch).
  When `review` finds a defect, all the host can reject is `review`, so `review` runs again
  and `implement` is never repaired.
- A producer's acceptance is requested as soon as its result is proposed, before the nodes that
  check it have run. Whatever the host decides then cannot cite their receipts.
- When a producer is retried, the nodes that consumed its old result through a `result_ready`
  edge keep their state. Cascading invalidation is deferred.
- A retry starts with nothing from the failed attempt, so it is a re-roll rather than a repair
  (design document §6 requires each loop to record what failed).

A falsifier, a task that tries to produce a reproducible counterexample, only pays off once
its findings reach the producer. This record settles that path for one flat graph.

## Decision

1. **Verifying nodes.** A node with a `result_ready` edge from producer `P` is a *verifying
   node* of `P`. Graph validation rejects a graph in which a verifying node of `P` is also
   reachable from `P` through a path containing an `accepted` edge. That graph would deadlock:
   `P` waits for the verifying node, and the verifying node waits for `P`.
2. **Candidate binding.** `attempt_dispatched` for an attempt of a verifying node records the
   producer attempt it consumes. The reducer stores that binding on the attempt. An outcome
   bound to a producer attempt that is no longer current is rejected as stale.
3. **Deferred producer acceptance.** A producer without verifying nodes behaves as today. A
   producer with verifying nodes enters disposition `verifying` when its result is proposed.
   The reducer emits `evaluate_acceptance` for it only when every verifying node has an accepted
   result bound to the current candidate. It rejects an `acceptance_decided { decision:
   "accepted" }` for `P` while any verifying node lacks one.
4. **A verifying node's outcome versus its verdict.** Accepting a verifying node's own result
   means its evidence is valid and reproducible; it says nothing about `P`. The verdict on `P`
   travels in the node's receipts: a `CheckReceipt` outcome, or the per-criterion verdicts in a
   `ReviewReceipt`. Rejecting a verifying node's result retries that node. A failing verdict
   rejects `P`.
5. **Fail fast.** While `P`'s attempt is `result_ready`, the host may send `acceptance_decided
   { nodeId: P, decision: "rejected" }` citing a failing receipt, before the other verifying
   nodes finish.
6. **Repair is a new producer attempt.** Rejecting `P` with attempts left supersedes the attempt,
   as today. The next `DispatchCommand` for `P` carries `repairOf: { attemptId, receiptIds }`. The
   host builds the repair packet from those receipts. The reducer carries only identifiers.
7. **Invalidation cascades.** When `P`'s attempt is superseded or rejected, every node that
   consumed it is invalidated, and so, transitively, is every node that consumed the result of
   an invalidated node through any edge:
   - an in-flight attempt receives `cancel_attempt` and ends `stopped`; its permit is released on
     `attempt_stopped` as today;
   - a proposed or accepted result gets disposition `invalidated`, and the node returns to
     `pending`;
   - nodes that depend on `P` itself through an `accepted` edge cannot have started, because `P`
     was never accepted.
   Invalidated attempts are not counted against the consumer's own retry allowance. They still
   count toward the run's lifetime attempts and, once it exists, the root budget.
8. **Exhaustion.** A producer that runs out of attempts ends `exhausted` with failure category
   `check_failed` or `review_rejected`, taken from the rejecting receipt. Its dependents fail as
   they do today.
9. **Only reproducible failures reject on their own.** A failing `CheckReceipt` rejects `P`. This
   includes a falsifier's counterexample once the host has run it as a check and it fails against
   `P`'s candidate. A model judgment alone never rejects `P` and never accepts it:
   - A first review of a candidate whose criteria all `pass` settles the review.
   - A `fail` or `unclear` verdict does not. The host rejects the review node's attempt, which
     starts a fresh, independent review of the same candidate within that node's retry allowance.
   - After that, `P` is rejected when two reviews of the same candidate both `fail` the same
     criterion, and the review passes when two reviews both pass every criterion. An `unclear`
     verdict never counts toward either.
   - If the review node runs out of attempts without agreement, it ends `exhausted`. `P` is never
     accepted, and the run ends through the existing dependency-failure path.
   A falsifier counterexample that the host cannot reproduce is handled like a model-only `fail`.
10. **Counterexamples become required checks.** A counterexample that rejected `P` is added to the
    checks required for every later attempt of `P` in this run. It is recorded with the rejecting
    receipt, not as a graph revision. The host may add required checks in this way but never
    remove them, so repair can only tighten acceptance.

## Consequences

- New journal fields: the consumed producer attempt on `attempt_dispatched` and `repairOf` on
  `DispatchCommand`. Both are wire contracts and need a schema version bump.
- New graph validation issue code for a verifying node reachable through an `accepted` path.
- The design gains a `falsifier` role; `RoleSchema` gains it with the first implementation.
- Rejection handling stays per node, but the host now rejects the producer for a failing
  verdict, which triggers the cascade. Existing rejection tests gain invalidation assertions,
  and the demo graph gains `result_ready` edges from `implement` to each verifying node.
- New tests: fail-fast rejection, stale outcomes after a repair, cascading cancellation of
  in-flight verifying nodes, invalidation during cancellation, exhaustion after repeated
  failures, review disagreement until exhaustion, a counterexample required on the next
  attempt, and replay equivalence. `npm run sim` needs such graphs among its seeds.
- A review node should allow at least three attempts, so a disputed first review can still be
  settled. With fewer attempts, a candidate is accepted only on a first clean review.
- Review agreement and counterexample reproduction are host policy (AP-12). The reducer sees only
  the resulting `acceptance_decided` events, as before.
- A separate semantic-repair counter, progress fingerprints and hypotheses (AT-15) stay with
  AP-17. This record provides only the attempt path those counters will bound.
- Nested graphs are out of scope. A child graph's boundary failure (AP-21) builds on this rule
  but needs its own record.
