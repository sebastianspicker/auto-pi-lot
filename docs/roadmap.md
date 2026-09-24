# Implementation roadmap

Plan revision 3 — 2026-09-24. Packages restructured per
[decision 0004](decisions/0004-three-packages.md): `contracts`+`engine` merged into `core`,
`pi-adapter`+`pi-extension` merged into `pi`. AP-01, AP-26 and AP-27 are in progress, but
their recorded evidence describes the pre-restructure tree and needs a fresh review before
any status change; everything else is unimplemented.

The [design document](design.md) specifies the target design. The
[implementation ledger](implementation-ledger.json) is the authoritative source for AP IDs,
dependencies, deliverables, status and evidence; this page just orients you toward it. The
[acceptance matrix](acceptance-matrix.md) defines AT-01–AT-41 verification obligations.

| Milestone | Work packages | Exit condition |
| --- | --- | --- |
| M0 — Scaffold | AP-00 | Historical 11-test foundation and plan-only demo; no runtime execution. |
| M1 — Durable foundation | AP-01–AP-07, AP-26, AP-27 | Versioned contracts, semantic validation, frozen policy, chosen SQLite backend, journal/artifacts/accounting, sequential fake-worker graph with restart. |
| M2 — Flat coding product | AP-08–AP-15 | Controlled worker processes, closed Pi boundary, automatic planning, dirty-workspace preservation, trusted checks, serial integration, recoverable supervisor and graph-mode UI. |
| M3 — Early live baseline | AP-16 | Small authorized corpus measured against a single Pi session, with explicit limits and observed failures. |
| M4 — Complete recursive execution | AP-17–AP-21 | Bounded loops/revisions, child admission, suspension/delivery, grandchildren, global cancellation and nested boundary repair/clarification. |
| M5 — Context and operations | AP-22–AP-23 | Artifact-backed context reduction, indexed inspection, retention/restore and evidence export. |
| M6 — Qualification | AP-25 then AP-24 | Packaging/platform evidence followed by full recursive live evaluation under a frozen plan. |

Start with **AP-01**. Separate worker result proposals from host acceptance, add versioned
identities, and define provisional-output dependency conditions. Its first increment does
not need a database driver, worker process or provider call. AP-02, AP-03 and AP-04 can then
progress independently against agreed contracts. The ledger specifies the remaining DAG;
milestone numbering does not imply every task waits for the previous milestone.

AP-16 requires a working bounded flat path and live authorization. Missing credentials or
authorization hold that qualification gate, not independent offline implementation.
Final-payload admission and accounting are required before any live calls; advanced context
optimization follows the functional path.

A local experimental release requires the offline/runtime packages and AP-25 evidence on
each claimed platform. Full product effectiveness additionally requires AP-16 and AP-24.
Neither documentation nor predecessor verification satisfies those gates. The ledger records
current package status; no AT scenario is fully verified.

A [foundation-hardening proposal](archive/2026-09-24-foundation-hardening.md) suggested
pulling pure transitions ahead of storage (AP-26) and adding repository gates (AP-27);
the ledger reflected it from plan revision 2. Plan revision 3 then restructured the seven
scaffold workspaces into three packages, `core`, `pi` and `cli`, per
[decision 0004](decisions/0004-three-packages.md); see [architecture.md](architecture.md).
