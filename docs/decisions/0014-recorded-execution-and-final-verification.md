# 0014 — Recorded execution and final-tree verification

Implemented 2026-10-08 at the maintainer's direction, with self-review and automated verification.
Extends 0008 and 0010; replaces the current-configuration resume behavior described by 0012.
Work packages AP-08, AP-11, AP-12 and AP-27. Ledger qualification remains separate.

## Context

Replaying a plan and policy while loading today's checks or model can silently change the work
being resumed. Per-task acceptance also cannot prove that later writers preserved earlier work.
A successful CLI-only post-check would not repair a journal that already declared success.

## Decision

1. New CLI runs record an execution manifest in `run_started`: worker kind and canonical
   workspace, plus the resolved model, thinking level, check commands with explicit defaults,
   and final check IDs for Pi. Credentials and environment values are excluded. Resume uses
   this manifest and refuses conflicting worker, workspace, model, thinking or config overrides.
   Journals without a manifest remain inspectable/replayable but cannot resume through the CLI.
2. Every new Pi run requires final verification. After all tasks are accepted, the reducer
   enters `verifying` and emits `verify_run`. The last durable acceptance event is the intent;
   the host never executes this effect before that append succeeds.
3. `WorkspaceVerifier` runs the union of node-declared checks and configuration `finalChecks`
   against one source digest. `finalChecks` can add an integration suite without running it on
   incomplete per-task output. Checks execute in configuration order. Each receipt and its
   logs are stored; source drift stops further checks and fails verification.
4. `run_verified` records outcome, source digest, selected profiles, receipt IDs and failure
   reasons. Only a complete passing result may produce `succeeded`. Final failure leaves task
   acceptance history intact but fails the run; it does not trigger automatic repair. An empty
   suite verifies source stability only and explicitly reports no deterministic check coverage.
5. Resume reruns unfinished verification. Cancellation aborts it and waits for cleanup; a
   concurrent passing result cannot override cancellation. Duplicate/late results are rejected.
   Failed persistence never exposes success. Completed runs resume without provider setup.
6. The evidence gate rejects check-backed proposals without a recorded result revision. Every
   accepted check must match that revision. The CLI exposes final receipts and their log IDs
   through `run` and `inspect`; `status` includes the final verification result.

## Consequences

Checks now run both at task acceptance and on the combined tree, increasing local execution
cost. Final failures require a new plan/run after inspecting evidence. The frozen recipe does
not freeze executables, dependencies, environment, provider implementations or source snapshots.
The same advisory locks, ignored-file exclusions and cooperative cancellation limits of 0013
apply. Outside edits remain unsupported. Evidence is trusted local data, not remote attestation.
