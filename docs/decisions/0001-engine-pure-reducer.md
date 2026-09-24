# 0001 — Engine is a pure reducer; recovery is replay

Accepted 2026-09-24. Work package: AP-26.

## Context

Plan revision 1 placed pure transitions (AP-07) after SQLite, journal and accounting
(AP-04–AP-06). That would shape the state machine around a store, and test nested waits,
cancellation, stale results and duplicate dispatch only through a database and processes.

## Decision

The engine exposes `decide(state, event) → { state, commands, rejection? }`, a total pure
function. Events are versioned journal records defined in `@auto-pi-lot/contracts`; commands
are engine-internal requests for effects (dispatch, run check, cancel, release permit).
`replay(events)` folds `decide` over the journal. Effects run outside the engine and report
back as new events. Stale, duplicate and out-of-order events return a typed rejection and
leave state unchanged. Hierarchy, budgets and suspension extend this reducer; there is no
second state machine.

## Consequences

- AP-26 precedes AP-05 and AP-07; storage persists the reducer's event vocabulary.
- Recovery (AP-14) replays committed events, then reconciles in-flight effects.
- Scheduler invariants are tested by seeded simulation without I/O.
- Event schemas are wire contracts: changes need a schema version and migration.
