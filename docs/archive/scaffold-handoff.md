# Handoff: current status and scope

> **Archived 2026-09-24.** Historical baseline only; superseded by the [design document](../design.md) and [ledger](../implementation-ledger.json). Do not update.

Snapshot: 2026-09-22, after the initial repository scaffold.

For subsequent implementation, use the [design document](../design.md),
[work ledger](../implementation-ledger.json), and [acceptance matrix](../acceptance-matrix.md).
They incorporate the predecessor review and refine the original next-task sequence below.
This document remains the dated scaffold status and verification record.

## Outcome and repository state

`auto-pi-lot` is an initialized local Git repository on `main`, with a strict TypeScript
npm workspace, design documentation, and a small tested graph foundation. There are
no commits yet; the scaffold and this handoff are untracked files at this snapshot.
Dependencies are installed locally, and generated build outputs are ignored by Git.

This is a scaffold, not a functioning autonomous graph harness. No supervisor, task
execution loop, database backend, or nested worker execution exists yet. No real model
calls were made during scaffold verification.

## Product objective and agreed scope

Build graph mode for the Pi coding agent using the Pi SDK. When enabled, the harness
should inspect the user's task, propose and validate a graph, execute its nodes, and
create bounded repair or investigation loops as needed. A root node may own a child
graph, and a child node may own a grandchild graph. Grandchildren cannot delegate further.

The first target is local autonomous coding and problem solving in one repository,
with one supervisor and a Pi terminal extension. Roles are planner, explorer,
implementer, verifier, reviewer, and integrator. Instantiate roles as needed rather
than maintaining a permanent agent for each role.

Core decisions to preserve:

- Agents propose plans and results; deterministic harness code controls execution
  and acceptance.
- Separate graph ownership, dependency edges, and attempt history.
- Keep each graph's dependencies acyclic. Represent loops with bounded attempts or
  immutable graph revisions.
- Use one global scheduler and one root budget across all descendants. Waiting parents
  release execution slots and resources needed by their children.
- Children can only narrow inherited permissions and scope. Budget reservations must
  be atomic and leave capacity for integration and verification.
- Isolate concurrent writers in Git worktrees and serialize integration. Verify the
  combined revision; child checks alone do not prove integration correctness.
- Persist intent before dispatch, reject stale workers, and reconcile ambiguous
  external effects. Arbitrary commands cannot be assumed to execute exactly once.
- Start with SQLite, Pi session files, content-addressed artifacts, and Git worktrees.
  A graph database, vector database, remote workers, and a web UI are outside the first scope.

## Implemented surface

| Package / area | Current implementation | Boundary |
| --- | --- | --- |
| `contracts` | Strict Zod schemas, inferred types, and `parseGraphSpec` / `validateGraphSpec` | Protocol draft; no schema version or stateful spawn admission |
| `engine` | `getReadyNodes`, node state union, and suggested policy defaults | No scheduler, state transition engine, budget enforcement, or dispatch |
| `storage` | Run store, journal event, artifact reference, and artifact store interfaces | No SQLite backend, migrations, transactional implementation, or artifact files |
| `pi-adapter` | Injected Pi session factory exposing prompt, abort, and dispose | No worker tool policy, transcript orchestration, or acceptance logic |
| `worker` | Worker assignment and session factory interfaces | No child process launch, leases, sandbox, or worktree manager |
| `pi-extension` | `/graph` command that reports scaffold status | Does not enable graph mode or intercept tasks |
| `cli` | Plan-only `demo` command | Prints a graph and initial ready nodes; executes nothing |
| Tooling | Pinned dependencies, lockfile, project references, test type checking, CI workflow | CI is configured but has not run on a hosted repository |

The graph parser checks structure, duplicate node IDs, missing edge endpoints,
duplicate/self edges, dependency cycles, owner/depth shape, and depth-2 delegation.
Readiness requires every incoming predecessor to be `accepted`; missing states mean
`pending`, and unknown state IDs are rejected.

Results require an input fingerprint. An accepted result requires evidence; an accepted
result with a code base revision also requires a result revision. These are structural
checks, not proof that evidence is correct or authority for a worker to accept its own work.

Suggested defaults are depth 2, 4 concurrent sessions, 24 total nodes, 2 repair rounds,
and 2 major replans. They are exported constants, not enforced runtime limits yet.

## Verification evidence

Last code verification was performed during scaffold creation:

- `npm run check` passed: package builds, test type checking, and all 11 tests.
- Tests cover graph shape/invariants, depth-2 delegation, accepted-result evidence and
  revision requirements, dependency joins, waiting/unverified states, and unknown state IDs.
- `npm run demo` passed and printed `implement → verify → review`, with `implement`
  as the only initially ready node.
- The installed Pi declarations compiled successfully against the adapter and extension.

Local verification used Node.js `26.9.0` and npm `11.19.1`. The declared minimum is
Node.js `22.19.0`, matching the pinned Pi dependency. CI targets Node 22; the minimum
version was not separately executed locally. Pi is pinned to
`@earendil-works/pi-coding-agent@0.87.0`.

Environment notes: Git initialization and npm registry access required sandbox approval.
The test runner's local IPC socket was blocked in the sandbox, so the successful check
ran with approval outside it. This was an environment restriction, not a test failure.
No interactive Pi extension smoke test, provider integration test, crash recovery test,
or persistence test has been performed. This handoff update changes documentation only;
its validation is link and consistency inspection, not a fresh runtime test run.

## Important gaps before execution

1. Add explicit wire schema versions, scoped tool/workspace policy, worker result
   proposals, and structured acceptance/check evidence. Keep graph revision separate
   from schema version.
2. Validate spawn requests against parent/run state: owner existence, depth increments,
   run identity, inherited scope, limits, and deduplication. Parsing their shape is insufficient.
3. Define legal state transitions and task delivery versus final acceptance semantics.
   Readiness currently trusts the supplied accepted states; there is no acceptance authority.
4. Implement transactional state/event persistence, revision compare-and-swap, ordered
   migrations, and recovery records. Evaluate `pi-durable` before selecting the backend
   implementation; that evaluation has not happened yet.
5. Define worker process control, tool enforcement, user steering, cancellation, and
   restart reconciliation before enabling autonomous execution.

Do not infer permission enforcement from role names, worktree isolation, or Pi session
options. No sandbox or permission policy has been implemented in this repository.

## Recommended next bounded task

Start milestone 1 in the [roadmap](../roadmap.md) with a deterministic sequential supervisor
using fake sessions. First version the contracts and separate a worker's completion
proposal from supervisor acceptance. Then implement legal transitions and dispatch
through an injected worker interface. Keep real-provider execution optional.

Acceptance criteria for that first increment:

- A supplied validated graph runs sequentially through fake workers.
- Dependents start only after the supervisor records the required predecessor acceptance.
- Failed, cancelled, or invalid results cannot silently become accepted.
- Attempts and transitions have stable identifiers and observable events.
- No model credentials or network access are required for its tests.
- The documentation continues to distinguish implemented behavior from the remaining
  persistence, planning, and nested-execution work.

Then complete milestone 1 with transactional storage, automatic planning, and Pi command
routing. Follow the existing roadmap for worktree integration/recovery before adding
children and grandchildren. Do not expand this next increment into a distributed runtime.

## Where to resume

Read [repository guidance](../../AGENTS.md), [architecture](initial-architecture.md),
contract semantics (then `docs/contracts.md`, now `packages/core/README.md`), and [roadmap](../roadmap.md), then the relevant package
README. Source entry points are `packages/<package>/src/index.ts`; focused tests live
in `packages/contracts/test` and `packages/engine/test`.

```sh
npm ci --ignore-scripts
npm run check
npm run demo
```

Keep this handoff as a dated snapshot. Update it when implementation scope, verification,
or the next actionable milestone changes; keep durable contributor rules in `AGENTS.md`.

## Predecessor review — 2026-09-22

A follow-up architecture review covered the earlier `pi-graph` project from a local checkout.
The [review](../reviews/pi-graph-2026-09-22.md) covers its major runtime, persistence, Pi,
operator and evaluation subsystems and recommends selective adoption rather than a wholesale port.
The predecessor was left unchanged; auto-pi-lot remains the initial scaffold.

Its quality checks passed in an isolated copy. The full suite had 1,347 passes, three
live-provider skips, and three failures caused by missing Git metadata in the copy. After
restoring that fixture prerequisite, all three passed in a focused rerun. The
[verification record](../reviews/pi-graph-2026-09-22/verification.json) records exact qualifications
and source fingerprints; no live-provider effectiveness claim follows from these checks.

An offline reproduction confirmed that an admitted request failing before dispatch can
become irreconcilably uncertain in the predecessor. Our request state machine needs an
idempotent release path for proven unused reservations, separate from uncertain dispatch.
Child-boundary review recovery is also incomplete in the predecessor.

Before implementing the sequential supervisor, strengthen our contracts with wire versions,
immutable requirements, host check nodes, scoped delegation, and separate worker proposals,
check receipts and supervisor acceptance. Retain one root scheduler/account and depth 2.
Use the review's adoption checklist to bring over regression scenarios. Full research campaigns,
cache optimization, framework adoption and broad integrations remain deferred recommendations.
