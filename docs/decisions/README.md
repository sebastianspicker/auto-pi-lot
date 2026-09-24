# Decision records

Short records for choices that change semantics described in the
[implementation handoff](../implementation-handoff.md). Each states context, decision and
consequences. Superseded records stay in place with a pointer to their replacement.

| ID | Decision | Status |
| --- | --- | --- |
| [0001](0001-engine-pure-reducer.md) | Engine is a pure reducer; recovery is replay | Accepted 2026-09-24 |
| [0002](0002-validation-issue-model.md) | Validation returns all typed issues | Accepted 2026-09-24 |
| [0003](0003-port-location.md) | Ports live in the engine; placeholder packages re-export | Superseded by 0004 |
| [0004](0004-three-packages.md) | Three packages; ports arrive with their implementations | Accepted 2026-09-24 |
