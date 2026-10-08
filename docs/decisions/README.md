# Decision records

Short records for choices that change semantics described in the
[design document](../design.md). Each one states context, decision and
consequences. Superseded records stay in place with a pointer to their replacement.

| ID | Decision | Status |
| --- | --- | --- |
| [0001](0001-engine-pure-reducer.md) | Engine is a pure reducer; recovery is replay | Accepted 2026-09-24 |
| [0002](0002-validation-issue-model.md) | Validation returns all typed issues | Accepted 2026-09-24 |
| [0003](0003-port-location.md) | Ports live in the engine; placeholder packages re-export | Superseded by 0004 |
| [0004](0004-three-packages.md) | Three packages; ports arrive with their implementations | Accepted 2026-09-24 |
| [0005](0005-producer-targeted-repair.md) | Verification findings repair the producer and invalidate its consumers | Accepted 2026-09-26; reducer part implemented by 0007 |
| [0006](0006-dependency-failure-and-acceptance-evidence.md) | Exhaustion fails pending dependents, and acceptance cites evidence | Accepted 2026-10-05 |
| [0007](0007-verification-gates-acceptance.md) | Verification gates producer acceptance in the run reducer | Accepted 2026-10-05; host-policy paragraph superseded by 0010 |
| [0008](0008-host-persists-before-acting.md) | The host persists before it acts, and recovers by replay plus reconciliation | Accepted 2026-10-05 |
| [0009](0009-invalidation-during-cancellation.md) | Rejection invalidates consumers during cancellation | Accepted 2026-10-08 |
| [0010](0010-evidence-based-acceptance.md) | Acceptance is decided from recorded evidence; checks run inside the attempt | Accepted 2026-10-08; supersedes 0007's host-policy paragraph |
| [0011](0011-one-workspace-serialised-writers.md) | One workspace per run; writers are serialised by the reducer | Accepted 2026-10-08 |
| [0012](0012-in-process-session-worker.md) | The first real worker runs Pi sessions in the host process | Accepted 2026-10-08 |
| [0013](0013-serial-evidence-and-run-ownership.md) | Serial evidence, CLI run ownership, and cooperative deadlines | Implemented 2026-10-08; self-verified |
| [0014](0014-recorded-execution-and-final-verification.md) | Recorded execution manifests and final-tree verification | Implemented 2026-10-08; self-verified |
