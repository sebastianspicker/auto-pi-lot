# 0007 — Verification gates producer acceptance in the run reducer

Accepted 2026-10-05. Implements the reducer part of [decision 0005](0005-producer-targeted-repair.md).
Work packages: AP-26, AP-12, AP-17.

## Context

[Decision 0005](0005-producer-targeted-repair.md) settled how verification findings reach the
producer of a flat graph: deferred producer acceptance, candidate binding, fail-fast rejection,
repair as a new producer attempt and cascading invalidation. Until now the reducer requested a
producer's acceptance as soon as its result was proposed, retried only the rejected node and
left the nodes that consumed a rejected result untouched.

## Decision

The reducer implements items 1, 2, 3, 5, 6, 7 and 8 of decision 0005, and `RoleSchema` gains
the `falsifier` role.

1. **Validation.** Validation checks exactly the deadlock, over a wait-for graph of the events
   "result of N" and "acceptance of N": an acceptance requires the node's own result and the
   acceptance of each of its verifying nodes; a result requires the result of each
   `result_ready` producer and the acceptance of each `accepted` producer. A `result_ready` edge
   `P -> V` is rejected with issue code `verifier_waits_for_acceptance` exactly when its
   requirement "acceptance of `P` requires acceptance of `V`" lies on a cycle of that graph,
   found in linear time from its strongly connected components. This replaces item 1's path
   rule. The path rule misses longer deadlocks, in which `V`'s acceptance needs `P`'s acceptance
   through the verification of other nodes, for example `P -> V (result_ready)`,
   `V -> W (result_ready)`, `P -> W (accepted)` (the seeded simulation found such graphs). It also
   rejects graphs that cannot deadlock, for example `P -> X (result_ready)`, `X -> Y (accepted)`,
   `Y -> V (result_ready)`, `P -> V (result_ready)`: `V` is reachable from `P` through an
   `accepted` edge, but `V`'s acceptance needs `X`'s acceptance, which needs only `P`'s result.
2. **Candidate binding.** When the reducer reserves an attempt, it binds the attempt to the
   current attempt of every producer of the node, through either edge condition. The binding is
   stored on the attempt (`consumes`) and carried on the `dispatch` command.
3. **Deferred acceptance.** A producer without verifying nodes is evaluated as before. A
   producer with verifying nodes enters disposition `verifying`, and the reducer emits
   `evaluate_acceptance` for it only once every verifying node holds an accepted result bound to
   the producer's current attempt. An accepted decision before that is rejected as
   `verification_incomplete`. If a verifying node loses its accepted result (it was invalidated
   through another producer), a pending request is withdrawn and emitted again once the
   verification is complete again.
4. **Fail fast.** A rejected decision applies at any time while the attempt is `result_ready`.
5. **Repair.** The next `dispatch` of a rejected node carries `repairOf: { attemptId,
   receiptIds }` from the most recent rejection. The reducer carries identifiers only. An
   accepted attempt of the node clears it, so a dispatch after a later invalidation is not a
   repair; invalidations and failures keep it.
6. **Invalidation.** Superseding or rejecting an attempt invalidates the current work of every
   node bound to it, transitively. A held reservation is dropped and its permit released. An
   in-flight attempt is asked to stop with `cancel_attempt`; a result it later proposes is
   rejected as `stale_candidate`, and whether it then ends `stopped`, `failed` or with an
   expired lease, its node returns to `pending`. It ends `failed` with `dependency_failed`
   instead when one of its producers is meanwhile exhausted or failed, and `cancelled` while the
   run is cancelling. A
   proposed or accepted result gets attempt status `invalidated` and node disposition
   `invalidated`, and its node returns to `pending`. An invalidated attempt does not count
   against its node's retry allowance (`attemptCount - invalidatedAttemptCount`). Attempt ids
   are derived from the run, the node, the attempt number and the fencing token, so a reservation
   dropped before its `attempt_dispatched` does not share its id with the node's next
   reservation.
7. **Exhaustion.** A producer that runs out of attempts ends `exhausted` with
   `review_rejected` and fails its pending dependents, as before.

Two deliberate deviations from decision 0005:

- **No new journal field.** Decision 0005 records the consumed producer attempt on
  `attempt_dispatched`. The reducer derives the binding deterministically from its own state
  when it reserves the attempt, so replay reproduces it without a wire change. The binding is
  carried on `DispatchCommand`, which is reducer-internal. Journal event schemas and
  `SCHEMA_VERSION` are unchanged.
- **An exhausted verifying node ends the producer's chance.** A verifying node that ends
  `exhausted`, `failed` or `cancelled`, or is itself a `verifying` producer in that situation,
  can never deliver accepted evidence. The producer's current result stays `verifying` and is
  never evaluated, its pending dependents fail with `dependency_failed`, and the run ends
  `failed` (or `cancelled`) without waiting for a decision on it.

**Known limitation.** Acceptance is a decision-time gate. A producer that is already accepted
keeps its acceptance when one of its verifying nodes is later invalidated through a different
producer, so a defect that verifying node finds on its re-run can no longer repair the
producer. Revoking an acceptance, and invalidating what consumed it, is a follow-up.

Host policy, not reducer logic: items 4, 9 and 10 of decision 0005. That covers interpreting
check and review receipts, review agreement, counterexamples as required checks, and the failure
category taken from the rejecting receipt. The reducer still records `review_rejected`.

## Consequences

- New rejection codes `verification_incomplete` and `stale_candidate`; new issue code
  `verifier_waits_for_acceptance`.
- `AttemptState` gains `consumes` and `invalidated`, and attempt status `invalidated`.
  `NodeRunState` gains `invalidatedAttemptCount`, `reservedConsumes`, `acceptanceRequested` and
  `lastRejection`. `DispatchCommand` gains `consumes` and `repairOf`.
- A host must accept a verified producer only after the reducer asked for it. The `trace`
  scenarios in `packages/cli` that accepted `implement` before `verify` were rewritten, and a
  fourth scenario, `repair`, shows a failing check sending `implement` back.
- Tests cover deferred acceptance, fail-fast repair, invalidated verifying results, transitive
  invalidation, dropped reservations, stale candidates, an exhausted verifying node,
  cancellation during verification and during an invalidation, and replay. The simulation
  checks the binding of every dispatch, deferred and withdrawn acceptance requests, the retry
  allowance, and early accepted and rejected decisions.
- Nested graphs remain out of scope.
