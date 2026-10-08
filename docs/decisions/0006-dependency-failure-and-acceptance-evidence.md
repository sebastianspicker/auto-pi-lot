# 0006 — Exhaustion fails pending dependents, and acceptance cites evidence

Accepted 2026-10-05. Work packages: AP-26 (reducer), AP-12 (acceptance gate).

## Context

Two gaps in the run reducer let the journal say less than the design requires:

- When a node ended `exhausted`, the nodes that depend on it stayed `pending`. The run only
  ended `failed` once a scan found that nothing could progress. The failure category
  `dependency_failed` existed but was never produced, so those nodes carried no typed outcome.
- `AcceptanceRecordSchema` requires at least one check or review receipt for an accepted
  decision, but `acceptance_decided` and the reducer accepted `{ decision: "accepted",
  receiptIds: [] }`.

## Decision

1. **Dependency failure.** When a node ends `exhausted`, every `pending` node that depends on
   it, transitively, becomes `failed` with failure category `dependency_failed`. Nodes that
   already started (`ready`, `running`, `result_ready`) keep their state and run to their own
   outcome, and the walk does not continue through them. A node that started on a producer's
   provisional result and is later retried with attempts left does not return to `pending`
   if that producer has meanwhile been exhausted: it fails with `dependency_failed` instead,
   and so do its own pending dependents. The run still drains in-flight work before it ends
   `failed`; this record adds no fail-fast policy.
2. **Evidence on acceptance.** An `acceptance_decided` event with `decision: "accepted"` must
   cite at least one receipt. The event schema enforces it, and the reducer rejects a violating
   event with `missing_evidence` for callers that bypass parsing. That check runs after the
   checks that the attempt exists, belongs to the named node and still awaits a decision, so an
   evidence-less decision on an already settled attempt is still `invalid_transition`. The reducer cannot verify the receipts themselves; that is AP-12's job.

## Consequences

- A failed run's journal shows which nodes failed and why. `isProgressImpossible` is unchanged.
- Tests cover both exhaustion paths, nodes that already started, and replay. The simulation
  asserts that no dependent of an exhausted or failed node stays `pending`, that every `failed`
  node is `dependency_failed`, and exercises `missing_evidence`.
- Hosts must attach a receipt to every accepted decision they journal.
- Decision 0005's cascading invalidation is still not implemented and will build on this rule.
