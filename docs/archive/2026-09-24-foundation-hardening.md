# Plan: foundation hardening before M1 storage work

Executed plan, kept for history; decision 0004 later restructured the packages it names.

Approved and implemented 2026-09-24 (uncommitted, awaiting independent review). The ledger
carries the delta as plan revision 2; AP-01, AP-26 and AP-27 record evidence there.

## Goal

Make the deterministic core testable as a pure state machine, and turn the repository's
written conventions into checks before storage, workers and Pi sessions add real effects.

## Why change the current order

The [ledger](../implementation-ledger.json) places pure transitions (AP-07) after SQLite,
journal and accounting (AP-04–AP-06). That means the state machine is designed around a
store instead of the reverse. A pure `decide(state, event) → { state, commands }` reducer
written directly after AP-01:

- makes journal replay and crash recovery the same code path (fold committed events);
- lets nested waits, cancellation, stale results and duplicate dispatch be tested as event
  sequences with no database, process or model;
- gives AP-05/AP-06 a fixed event/command vocabulary to persist rather than invent.

This refines, not replaces, [design document](../design.md) §4 and §8:
engine stays deterministic, ports stay injected, SQLite stays the single authority.

## Increments

Each increment ends with `npm run check` exiting 0 and a handoff note. Ledger status changes
only with exact-source evidence, per handoff §16.

### P0 — Repository cleanup (done 2026-09-24, uncommitted)

- Archived `docs/handoff.md` → `docs/archive/scaffold-handoff.md` and `docs/architecture.md`
  → `docs/archive/initial-architecture.md`; updated every link and the ledger paths.
- `.agents/` added to `.gitignore` (AGENTS.md already declared it ignored).
- CI uses `node-version-file: .node-version`; actions pinned by commit SHA.
- `npm test` split into `typecheck:test` and `test:unit`; `check` unchanged in effect.
- Open: the first commit has not been made yet. No retrospective AP-00 fingerprint.

### P1 — Repository gates (AP-27; implemented)

| Step | Change | Files |
| --- | --- | --- |
| 1 | Formatter and linter: Biome, pinned, `npm run lint` | `biome.json`, `package.json` |
| 2 | Import boundaries: a dependency-free scanner (dependency-cruiser 18.4 does not support TypeScript 7) — Pi SDK only in `pi-adapter`/`pi-extension`; `engine` imports only `contracts`; `contracts` imports only `zod` | `scripts/check-boundaries.ts`, `npm run boundaries` |
| 3 | Ledger validator: schema-check `implementation-ledger.json`; AP/AT IDs unique; `dependsOn` and scenario refs resolve; AP DAG acyclic; every `implemented` task has ≥1 evidence record with a non-null commit; `owns`/doc paths exist where the task is not `not_started` | `scripts/check-ledger.ts`, `npm run ledger` |
| 4 | Link checker for relative Markdown links and ledger doc paths (as run ad hoc in P0) | `scripts/check-links.ts`, `npm run links` |
| 5 | `check` = `build → typecheck:test → lint → boundaries → ledger → links → test:unit` | `package.json` |
| 6 | Claude Code Stop hook running `npm run check` (project `.claude/settings.json`); Codex equivalent noted in AGENTS.md | `.claude/settings.json`, `AGENTS.md` |

Tests: the ledger validator gets fixture tests (cycle, dangling ref, implemented-without-evidence).
Done: all gates pass on the current tree; each gate demonstrably fails on a seeded violation.

### P2 — AP-01 contracts (implemented)

Split `packages/contracts/src/index.ts` into `ids`, `graph`, `node`, `result`, `attempt`,
`events`, `validation`, re-exported from `index.ts`.

- **One state vocabulary.** Replace engine `NodeState`, `AttemptRecord.status` and
  `NodeResult.status` with `ExecutionState` and `ResultDisposition` from handoff §7.
  Engine imports them; it no longer declares its own.
- **Edge conditions.** `EdgeSpec.condition: "result_ready" | "accepted"` (required, no default).
- **Structured validation.** `validateGraph(g): { ok: true; graph: ValidatedGraph } | { ok: false; issues: ValidationIssue[] }`,
  with `ValidationIssue = { code, path, message }` and a closed `code` enum
  (`duplicate_node`, `unknown_edge_endpoint`, `self_edge`, `duplicate_edge`, `cycle`,
  `depth_owner_mismatch`, `delegation_beyond_depth`, …). Collect all issues, not the first.
  Keep `parseGraphSpec` as a throwing wrapper for callers that want it.
- **Branded `ValidatedGraph`.** Only `validateGraph` produces it; `getReadyNodes` accepts it
  and stops reparsing on every call. Replace recursive DFS with Kahn's algorithm, which also
  yields a deterministic topological order for the scheduler.
- **Wire identity.** `schemaVersion` literal on every persisted/exchanged DTO; canonical JSON
  (sorted keys, rejected `undefined`/non-finite numbers) plus SHA-256 identity, with committed
  test vectors in `packages/contracts/test/vectors/`.
- **Proposal ≠ acceptance.** `ResultProposal` (worker claim) and `AcceptanceRecord` (host
  decision) as separate schemas; a proposal cannot carry `accepted`.

Tests: AT-03 unit slice (typed rejections, version mismatch); AT-08/AT-09 schema slice
(proposal cannot self-accept; `result_ready` edge unlocks a verifier while `accepted` edge
stays blocked). Property tests (fast-check, pinned devDependency): generated DAGs validate;
adding any back edge yields a `cycle` issue; canonical encoding is key-order independent.

### P3 — Pure reducer core (AP-26; implemented)

New modules in `packages/engine/src/`:

- `state.ts` — `RunState` (graphs, node execution state, result dispositions, attempts,
  permits in use, remaining counters). Plain immutable data.
- `events.ts` / `commands.ts` — or in `contracts/events` if they cross process boundaries.
  Events: `RunAdmitted`, `AttemptDispatched`, `ResultProposed`, `CheckReceiptRecorded`,
  `ResultAccepted`, `ResultRejected`, `AttemptFailed`, `CancelRequested`, `LeaseExpired`.
  Commands: `Dispatch`, `RunCheck`, `CancelAttempt`, `ReleasePermit`, `CompleteRun`.
- `transitions.ts` — `decide(state, event): { state; commands; rejected?: RejectionReason }`.
  Total: every (state, event) pair returns a result; stale or duplicate events are
  rejected with a typed reason, never thrown.
- `replay.ts` — `replay(events) = events.reduce(decide)`; used by tests now and recovery later.

Scope for this increment: one flat graph, sequential dispatch, bounded retries, `result_ready`
vs `accepted` edges, cancellation. Hierarchy, budgets and suspension extend the same reducer
in AP-06/AP-18/AP-19 — no second state machine.

### P4 — Deterministic simulation (AP-26; implemented)

`packages/engine/test/sim/`: seeded PRNG (small inline mulberry32, no dependency), fake clock,
fake worker that randomly succeeds, fails, duplicates, delays or reports after cancellation.
After every step assert invariants:

- no event is applied twice (idempotent on attempt ID);
- a node consuming an `accepted` edge never runs before its producer is accepted;
- permits in use ≤ `maxConcurrent`; a cancelled subtree dispatches nothing new;
- stale-attempt results are rejected; replay of the event log reproduces the final state.

Run a fixed seed set in `npm run check` (fast); a longer seed sweep via `npm run sim`.
Failing seeds are printed and become regression tests.

### P5 — Port consolidation (decision 0003; implemented)

Move `RunStore`, `ArtifactStore`, `WorkerAssignment` and `WorkerSessionFactory` into
`packages/engine/src/ports/`, reshaped around the P3 events (e.g. `appendEvents(expectedSeq, events)`
instead of `commitGraphRevision`). Remove `storage` and `worker` from the workspace until
AP-04/AP-08 add implementations, or keep them as empty shells — decide in the ADR.
Handoff §4 already allows relocating scaffold interfaces; the code map needs a one-line update.

### P6 — Session event port (AP-09 precursor; implemented, interface only)

Extend `CodingSession` with an async event stream: `usage`, `tool_call`, `settled`, `error`,
defined provider-neutrally in contracts. `pi-adapter` maps SDK events; a fake session emits
scripted events for P4. No live calls; AP-09 still owns request admission.

## Proposed ledger delta

Applied as `planRevision: 2` on 2026-09-24, keeping existing IDs stable.

| Change | Detail |
| --- | --- |
| Add AP-26 | "Pure reducer and deterministic simulation"; `dependsOn: [AP-01]`; owns `engine/src/{state,events,commands,transitions,replay}`, `engine/test/sim` |
| Add AP-27 | "Repository gates"; `dependsOn: [AP-00]`; owns `scripts/`, `biome.json`, `.claude/settings.json` |
| AP-07 | Add `dependsOn: AP-26`; narrow to "storage-backed sequential fake-worker slice" |
| AP-05 | Add `dependsOn: AP-26` so the journal persists the reducer's event vocabulary |
| AP-25 | Leave CI qualification there; AP-27 covers only local/CI gates |

ADRs in `docs/decisions/` (the location AP-04 already owns):
`0001-engine-pure-reducer.md`, `0002-validation-issue-model.md`, `0003-port-location.md`.

## Sequencing and delegation

```text
P0 (done) ─ P1 ─────────────────────────┐
            P2 ─ P3 ─ P4 ─┬─ P5 ─ AP-04/AP-05 …
                          └─ P6
```

P1 and P2 touch disjoint files and can run as parallel implementers. P3 and P4 belong
together and should be one owner, since the reducer and its invariants co-evolve. The
integrating agent owns the ledger, ADRs and cross-package contract changes. Each increment:
implementer → diff read → `npm run check` → reviewer; Codex reviews before the operator commits.

## Open decisions

1. Approve the ledger delta (AP-26/AP-27 and the AP-05/AP-07 dependency change)?
2. Biome (one dependency) or ESLint + Prettier?
3. Remove placeholder `storage`/`worker` packages until implemented, or keep empty shells?
4. Do events/commands live in `contracts` (cross-process wire types) or `engine` (internal)?
   Recommendation: journal events in `contracts`, commands in `engine`.

## Outcome notes

- Open decisions were resolved as: ledger delta applied; Biome; `storage`/`worker` kept as
  re-export shells; journal events in `contracts`, commands in `engine`.
- dependency-cruiser 18.4 does not support TypeScript 7, so boundaries use the dependency-free
  `scripts/check-boundaries.ts` instead.
- Independent review found two reducer defects the first simulation could not reach (a second
  acceptance decision for one attempt was applied; cancellation dropped outstanding acceptance
  evaluations). Both are fixed with regression tests, and the simulation now sends conflicting
  decisions and checks acceptance stability and reconciliation before terminal states.
- Known limits: rejecting a producer does not invalidate dependents that consumed its
  provisional output (later work); session `settled: completed` covers every non-abort,
  non-error stop reason, including length truncation.

