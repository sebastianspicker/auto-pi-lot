# Full-project implementation handoff

Plan revision 1 — 2026-09-22. **Target design; implementation remains the initial scaffold.**

This is the engineering handoff for building the complete local auto-pi-lot product. It
combines the [scaffold handoff](archive/scaffold-handoff.md), [architecture](archive/initial-architecture.md), and
[pi-graph review](reviews/pi-graph-2026-09-22.md). The predecessor is a reference, not a
dependency or an automatically approved source transplant.

## 1. Authority and how to use this handoff

| Document | Owns |
| --- | --- |
| `AGENTS.md` | Durable contributor rules, commands and invariants |
| This handoff | Target architecture, protocol behavior, boundaries and implementation decisions |
| [Architecture](architecture.md) | Current code structure, boundaries and placement rules |
| [Implementation ledger](implementation-ledger.json) | Work-package IDs, dependencies, implementation status, deliverables, acceptance and evidence |
| [Acceptance matrix](acceptance-matrix.md) | Proposed failure scenarios and observable assertions |
| [Roadmap](roadmap.md) | Milestone navigation into the ledger |
| [Scaffold handoff](archive/scaffold-handoff.md) | Dated baseline and observed scaffold verification |
| [Legacy review](reviews/pi-graph-2026-09-22.md) | Source-backed transfer recommendations and predecessor findings |

This handoff refines earlier plans where they differ: validate and account for the final
provider payload before any live calls; evaluate a small live coding path before adding
advanced optimization; distinguish execution results from acceptance; and build a release
path for reservations proven unused before dispatch.

Do not treat a document, proposed API, scaffold interface, or predecessor test as an
implemented feature of this repository. Update the ledger only with evidence for the
changed auto-pi-lot source. Implementation decisions that change these semantics require a
short ADR and corresponding contract/failure tests. Ordinary implementation choices do not
require repeated user approval.

## 2. Current baseline

Three npm workspaces exist today, per [decision 0004](decisions/0004-three-packages.md):
`core` (the deterministic, provider-neutral domain), `pi` (all Pi SDK code) and `cli` (the
operator entry point). Strict TypeScript ESM/project references, pinned dependencies and CI
configuration are present. Pi is pinned to `0.87.0`; Node minimum is `22.19.0`.
[Architecture](architecture.md) describes current code structure, enforced boundaries and
where new code goes; this section does not restate it.

The [ledger](implementation-ledger.json) is authoritative for what is implemented, with
exact-source evidence per package. Its plan revision 3 note records that the AP-01, AP-26 and
AP-27 evidence predates the restructure: those fingerprints no longer match the current tree,
and a fresh review is required before any status change.

The predecessor's local suite and two offline bug reproductions establish only its reviewed
snapshot. They are useful test designs, not additional passes for auto-pi-lot.

### Legacy transfer register

The [review](reviews/pi-graph-2026-09-22.md) retains source references and verification
limits. Translate its behavior into these work packages rather than copying its full stack.

| Legacy lesson | Implementation destination | Required adaptation |
| --- | --- | --- |
| Durable intake and clarification identity | AP-10, AP-15 | Capture the AP-11 baseline before planning; keep the same root account across answers. |
| Host-authorized graph contracts and checks | AP-01–AP-03, AP-12 | Separate provisional output from acceptance and close delegation grants by default. |
| Flat scheduler over nested ownership | AP-18–AP-21 | Enforce depth 2 and global permits; parent suspension cannot hold descendant resources. |
| Closed SDK resources and exact routes | AP-09 | Prove behavior against this repository's pinned SDK, not the predecessor's older version. |
| Final-payload request admission | AP-06, AP-09 | Include proven-unused release, crash recovery and explicit usage uncertainty. |
| Transactional state and effect intent | AP-04–AP-08, AP-14 | One SQLite authority; avoid introducing a second LangGraph checkpoint store. |
| Evidence tied to exact candidate inputs | AP-11–AP-13 | Preserve dirty baselines and verify the serially integrated tree. |
| Typed loops and boundary failures | AP-17, AP-21 | Complete child/grandchild repair and clarification; generic blocked-to-finish routing is insufficient. |
| Context provenance and reduction | AP-09, AP-22 | Minimal bounded packets first; retained artifacts are required for claimed reversibility. |
| Identity-preserving graph-mode UX | AP-15 | Preserve unsent input; reload does not resubmit; off does not cancel. |
| Real local effects under fake reasoning | AP-07–AP-15, AP-25 | Use real temporary DB/Git/process fixtures with fault injection and exact-source receipts. |
| Large test suite versus useful coding | AP-16, AP-24 | Measure a small live corpus separately; avoid importing broad prompt-search/evaluation machinery. |

Do not migrate predecessor databases, copy its private local configuration, preserve its
multiple historical hash formats, or transplant its broad evaluation/security subsystems.
The fresh repository needs one canonical identity format and only the runtime machinery
required by the acceptance scenarios.

## 3. Complete local product scope

An operator enables graph mode, supplies a coding or problem-solving task, and sees the
harness inspect context, create a bounded graph, execute permitted work, verify outcomes,
repair failures, and deliver a reviewable result. Eligible nodes can request child graphs;
child nodes can request grandchildren. The host creates and validates each graph.

The complete v1 includes:

- Durable task intake, planning, clarification, execution and immutable history.
- One scheduler and root account spanning all roles and generations.
- Root depth 0, children 1, grandchildren 2; no delegation beyond depth 2.
- Scoped workers, typed artifacts, host checks, independent review and serial integration.
- Safe handling of existing user changes, isolated writing workspaces and bounded commands.
- Restart reconciliation, stale-worker rejection, pause/resume, cancellation and user steering.
- Pi terminal commands/progress, a CLI, inspectable state and exportable outcome evidence.
- Deterministic local tests plus a small separately authorized live task evaluation.

Target repositories are language-agnostic: their instructions and configured tools/checks
define verification. Non-coding investigations return evidence-bearing artifacts and explicit
uncertainty. They may use a deliberately configured review-only acceptance mode; a model
cannot switch a coding task to review-only to avoid failing mandatory checks.

Out of v1: remote workers, distributed queues, a fleet daemon, mutable web dashboard,
unbounded recursive agents, vector/graph databases, automatic deployment/publication,
security research engines, prompt search campaigns, speculative cache warming, and compatibility
with predecessor SQLite databases. None is needed to prove the core workflow.

## 4. Target package boundaries and code map

Three packages exist today; the modules below name where growing deterministic work goes,
not a proposed future layout. Effect packages are created with their first implementation,
not declared ahead of a consumer.

| Package | Modules to grow | Responsibility |
| --- | --- | --- |
| `core` | `graph/` (spec, validation); `run/` (state, events, commands, decide, replay, evidence, status, and future scheduler, budget, intake, planning, acceptance, loops, hierarchy, recovery, context, policy modules) | The deterministic, provider-neutral domain: wire schemas, canonical identity, graph admission, the reducer and its extensions, plus the session port |
| `pi` | `session`, `map-event`, `extension` | Everything coupled to the Pi SDK: the session adapter and the Pi extension entry point |
| `cli` | `commands`, `composition`, `supervisor`, `ipc`, `inspection` | Resource composition, local supervisor startup and operator CLI |

Future effect packages, created together with their first implementation:

| Package | First owner | Responsibility |
| --- | --- | --- |
| `storage` | AP-04 (backend decision), AP-05 (implementation) | Transactional state/journal implementation and immutable artifact storage |
| `worker` | AP-08 (protocol/process/broker), AP-11 (workspace/commands), AP-13 (integration) | Worker process lifecycle and the host-owned effect executor; workers request effects through the broker |

Dependency direction: `core` is lowest and depends on no workspace. `pi` and `cli` depend on
`core`; `pi` imports only the `@auto-pi-lot/core/session` subpath, never the full domain, so
SDK-coupled code cannot reach into run decisions. A port interface (a journal store, a worker
dispatcher) is added to `core` in the same change as its first implementation, shaped by what
the reducer and that implementation actually need, not declared speculatively ahead of a
consumer ([decision 0004](decisions/0004-three-packages.md)). Storage and worker, once
created, implement the ports `core` declares for them; avoid a catch-all mutable Controller or
passing a whole store to every component when they are added. Keep Pi SDK imports inside
`pi`. No adapter import or database handle belongs in the deterministic reducer. Boundaries
are enforced by Biome (`noUndeclaredDependencies`, `noRestrictedImports`, `noImportCycles`);
see [architecture.md](architecture.md).

## 5. State authority and protocol identities

SQLite is authoritative for run decisions, graph revisions, attempts, reservations, leases,
effects and accepted evidence. Pi transcripts are conversation history. Artifact files are
immutable payloads addressed by digest. UI status and scheduler queues are rebuildable views.
There is one state owner; no additional LangGraph checkpoint system in the initial engine.

Keep independent versions for wire schemas, database migrations and executable compatibility.
Graph revision is plan content history, not a schema version. Add tool/prompt contract identity
when sessions run; add cache identity only when caching needs it. Do not copy the legacy
graph/schema/runtime version numbers or its 19 migrations into a fresh database.

Use stable generated IDs for run, graph instance, node, attempt, request, event and artifact.
Store scoped keys as tuples, not ambiguous string concatenations. A graph instance retains
its identity across revisions. Each actual execution gets a new attempt and segment identity.
Retries use idempotency keys bound to the full canonical request; same key/different content
is a conflict, not permission to overwrite history.

Specify one canonical JSON representation for new persisted identities: validate DTOs first,
reject unsupported values, define optional-field/array/number behavior, sort object keys
deterministically, and maintain test vectors. Historical hash algorithms are irrelevant unless
an explicit import feature is later authorized.

## 6. Required contracts

| Contract | Required behavior/data |
| --- | --- |
| `RunSpec` | Objective, immutable root requirement IDs, baseline, policy reference, budget envelope, task request identity |
| `RunAmendment` | Explicit operator steering, prior revision, changed requirements/scope, authorization provenance and invalidated work |
| `GraphRevision` | Graph/run identity, revision, owner binding, depth, nodes/edges, immutable external input/output contracts |
| `NodeSpec` | Kind, objective, requirements, role if needed, inputs/outputs, acceptance gate, grants, limits and explicit delegation ceiling |
| `Dependency` | Producer, consumer, artifact binding and required condition (`result_ready` or `accepted`) |
| `WorkerAssignment` | Attempt/segment/revision, fencing token, workspace/base identity, exact route, frozen grants/context and deadline |
| `ResultProposal` | Worker claims, output artifact IDs, limitations, declared changes and requested checks; cannot claim host acceptance |
| `CheckReceipt` | Profile/version, executable/args identity, environment, input/source digest, exit/outcome, test count when supported and log artifacts |
| `ReviewReceipt` | Reviewed candidate, criterion verdicts, evidence IDs and limitations; model judgment remains distinguishable from measured checks |
| `AcceptanceRecord` | Host decision, candidate/input fingerprint, required receipts, deciding policy/revision and invalidation state |
| `SpawnRequest` | Parent instance/node/attempt, reason, request identity, narrowed authority, inputs, output contracts, child ceiling and remaining depth |
| `SuspensionRecord` | Completed parent exchange, persisted continuation reference, released capacity and child request identity |
| `ChildResult` | Accepted/failed/cancelled/exhausted disposition, contract-bound outputs, check/review evidence, unresolved issues and consumed allowance |
| `EffectRecord` | Intent identity, expected preimage, effect type, dispatch/receipt/reconciliation state and recoverability classification |
| `JournalEvent` | Version/type, ordered sequence, run and full graph/node/attempt identity, causal command ID and bounded typed payload |

Strict schema parsing precedes semantic checks. Validation must prove graph-local DAGs,
owner existence, depth increments, unique identities, requirement coverage, declared artifact
dependencies, authorized roles/models/checks, scope narrowing and reachable acceptance.
Cross-graph data travels through declared immutable bindings. An ancestor-completion dependency
cannot be introduced into its own child. No model output changes root requirements or policy.

Operator steering is different: persist an explicit amendment, pause affected dispatch,
invalidate stale contracts/evidence and revise deliberately. Preserve the original objective
and prior decisions in history. New text during a run is not automatically a replacement task.

## 7. Execution and acceptance are separate

The scaffold currently unlocks every edge only on `accepted`. That is insufficient once
verification becomes a real downstream node: do not mark implementation accepted merely
to let its verifier start.

Use a dependency condition and two related state dimensions:

- Execution: `pending`, `ready`, `running`, `waiting_children`, `waiting_input`,
  `waiting_approval`, `result_ready`, `failed`, `cancelled`, `exhausted`.
- Acceptance for a result: `unverified`, `verifying`, `accepted`, `rejected`, `invalidated`.

A verifier/check consumes provisional output using an explicit `result_ready` edge. A task
requiring trusted output consumes an `accepted` edge. The host's acceptance gate updates the
result disposition when its required receipts exist; this is not a cyclic graph dependency.
Child failure continuation uses a typed terminal-outcome binding, never a fabricated success.

The run lifecycle is `planning → running → verifying → succeeded`, with explicit waiting,
paused, blocked and terminal failed/cancelled/exhausted outcomes. `blocked` is nonterminal and
contains a typed reason plus permitted resolution; it is not another word for failed. Pausing
stops new dispatch and waits for a documented safe checkpoint. Cancellation stops the subtree,
reconciles in-flight work and becomes terminal; ordinary resume does not undo cancellation.
An explicitly requested successor run records lineage and a newly authorized budget.

Graph instance completion requires settled descendants, effects, output contracts and local
acceptance. Root completion additionally requires integration and current mandatory final
checks/review. A worker process exit, Pi settled event, or passing isolated check alone cannot
make the root succeed.

## 8. Scheduler, roles and loops

One global scheduler owns the runnable set. Start sequentially; add parallel immutable readers,
then isolated writers only after integration tests. Suggested defaults remain 4 active sessions,
24 lifetime admitted nodes, depth 2, 2 repair rounds per task, and 2 major replans. Explicit run
configuration must also resolve a global semantic-repair cap, request/tool/token limits and
deadline before dispatch. Exported defaults are not enforcement.

Runnable admission checks dependency condition, current revision, grants, budget, cancellation,
workspace ownership and available permits. Use deterministic ordering and bounded fair queues;
do not add a cost-prediction scheduler initially. Waiting parents release model/process permits
and any write lease their descendants need. Persist their continuation first, then dispose or
park their session without retaining a worker slot. Bound active child processes and queued nodes.

| Role | Model work | Host boundary |
| --- | --- | --- |
| Planner | Decomposition and graph/revision proposals | Read-only discovery and validated submission |
| Explorer | Bounded source investigation or hypothesis testing | Scoped reads/search and artifact return |
| Implementer | Candidate edits and repair | Workspace-specific writes and allowed command/check requests |
| Verifier | Interpret evidence, identify missing coverage when useful | Actual check execution is a deterministic check node |
| Reviewer | Independent criterion assessment | Reads candidate and evidence; cannot edit its way to a pass |
| Integrator | Resolve patch interaction when reasoning is needed | Host applies/stages candidates serially and runs final checks |

Roles are profiles, not permanent agents. A node may coordinate its child graph within the
same explicit delegation grant. Mechanical joins, checking, accounting and scheduling do
not need model calls. A one-node graph remains valid for a small task.

Keep transport retry, schema repair, semantic repair, investigation, continuation and replan
as distinct policies/counters. Each loop records the failure identity, proposed change or
hypothesis, expected observation and remaining allowance. Repeated unchanged outcomes stop.
Do not reset counters on compaction, child creation, restart or unrelated sibling success.
Adapting after a failed child is itself a root semantic-repair debit.

## 9. Budget and provider request state machine

Maintain one conserved root account. Child slices are earmarks/ceilings within it, not new
money or tokens. Nested request reservation transfers from an earmark; it must not be charged
twice as both a full child reserve and a separate root reserve. Persist reservation changes
atomically with admission and require `spent + outstanding reservations <= authorized limit`.
Return only unused reservations; settled usage, failed attempts and lifetime node admission
are not refunded. Reserve completion capacity for required checking, review and integration.

Before every provider request, check actual serialized payload bounds, exact route, output cap,
request count, deadline, cancellation and account availability. Disable unaccounted SDK retries.
Inspect the pinned Pi SDK for a supported request hook; prove the hook runs before transport.
If that boundary cannot be enforced, block the affected capability rather than claiming control.

```text
reserved -> released_not_dispatched     proven no transport dispatch
reserved -> dispatch_intent             persisted before transport can begin
dispatch_intent -> settled              qualified outcome/usage receipt
dispatch_intent -> uncertain            outcome or usage cannot be established
uncertain -> reconciled                 explicit validated resolution
```

Only a fenced owner with proof that dispatch was not possible may release a reservation.
For a crash in `reserved` before `dispatch_intent`, recovery must revoke/settle the previous
owner, confirm its process cannot dispatch, and verify the durable no-intent invariant under
the qualified request protocol. It can then release exactly once. If protocol compatibility
or dispatch history cannot be established, require explicit reconciliation instead of guessing.
Test this crash separately from a live cancellation. Absence of a completion receipt after a
crash is not proof of no dispatch. A crash after dispatch intent
but before the actual network request can legitimately remain uncertain. Cancellation,
deadline expiry or manifest-write failure before dispatch intent must release once and leave
the run usable. This is a mandatory regression for the confirmed predecessor defect.

Unknown usage is not zero. Persist raw bounded observation metadata and qualification separately
from accounting estimates; do not retain credentials or unnecessarily retain provider payloads.
An enabled monetary hard cap requires usable route pricing/reservation rules. A request-limited
mode can operate without exact cost reporting, but must label cost unknown and enforce its
other limits. Disabling or increasing limits requires an operator amendment, never model output.

Reservation bounds must cover the supported route's possible request/output usage. If observed
usage nonetheless exceeds a bound, record the actual overrun and stop new admission for
reconciliation; never clamp usage or fabricate account conservation. A local admission limit
does not guarantee a provider's billing behavior. Qualify hard-cap claims by the enforced
dimensions and the supported route's reservation guarantees.

## 10. SQLite, artifacts and migrations

Perform a bounded backend decision in AP-04: evaluate direct SQLite and available Pi durable
storage against transaction, migration, fencing, backup, runtime and failure-test needs. Keep
the application port stable; do not make this a general database framework. No backend is
selected merely by mentioning it in earlier discussions.

Target tables/collections: runs and amendments; graph instances/revisions; node revisions;
attempts/segments; journal events; artifacts and references; check/review/acceptance receipts;
accounts/reservations/usage; spawn/suspension/delivery records; worker leases; effects;
questions/answers and operator commands. Co-locate the invariants that must commit atomically.

Required constraints include unique scoped identities, immutable artifact/revision content,
idempotent command keys, compare-and-swap current revision, ordered events and fencing checks.
Index task request lookup, ready/waiting projections, graph ownership, unresolved effects
and account summaries. Avoid scanning all retained runs or usage rows for every admission.

Use local SQLite WAL with an explicit durability/backup policy. Prefer durable acknowledged
control commits; document any weaker setting. No transactions remain open while calling a
provider, running a command or waiting for a child. Persist intent, perform the effect, then
settle it in a new short transaction. Never claim atomicity across database and filesystem.

Artifacts: write bounded bytes to a temporary file, hash/flush/atomically install the blob,
then commit its reference. Verify digest and size on retrieval. An interrupted write may leave
an unreferenced blob for later collection, not a valid receipt referencing absent bytes.
Protect active attempts, child deliveries and unresolved effects from retention/GC. Back up the
database consistently with all referenced blobs and test restore; copying an open DB file alone
is not a backup procedure. Migrations are ordered, transactional where supported and checksum-bound.

## 11. Workspace and command execution

Capture a reproducible baseline including staged, unstaged and untracked operator work without
reset/stash or overwriting it. Preserve file modes, deletions, symlinks and relevant exclusions.
Workspace identity includes baseline revision plus content, not a commit ID alone. Do not
silently put secret/untracked ignored files into task packets or artifacts.
Record exclusions explicitly. If required inputs cannot be captured under current policy,
resolve the baseline requirement before planning rather than pretending the snapshot is complete.

Use a run integration workspace and task workspaces. One writer holds each workspace lease.
Every concurrent writer gets a separate worktree. Read-only concurrency uses immutable snapshots
or validated read sets, never a mutable tree being edited elsewhere. Sharing a parent workspace
with a child requires explicit lease handoff; otherwise fork from an identified parent snapshot.

Workers return candidate changes against a base fingerprint. The host applies them serially to
the integration workspace, records conflict/resolution, and reruns required checks on the combined
tree. Individually passing patches are not collectively accepted. Delivery is a branch/patch and
evidence report; modifying the user's checkout is a separate authorized action with drift checks.
No automatic commits, pushes, publication or deployment follow merely from graph completion.

File mutation tools bind to expected preimages; stale edits fail. Record effect intent and
postimage/receipt. Recovery verifies current bytes before deciding whether an edit happened.
Arbitrary command replay requires effect-specific idempotency or reconciliation. Checks bind
executable/argument/profile/environment/input identity, timeout and observable exit status;
parser-supported test counts are distinct from exit-code-only reports.

Initial command access is through configured profiles and argument arrays. Existing authorized
checks do not prompt on every call. New authority or an irreversible action follows the configured
operator boundary. An unrestricted shell, if explicitly enabled, carries real host authority:
path globs cannot confine it. A worktree or `shell: false` is not an OS sandbox. v1 supports
trusted local repository processes and must say so; hostile-workload isolation is separate work.

## 12. Worker processes, supervisor and recovery

Start one supervisor on demand for a canonical repository/store identity. It may survive a
Pi UI disconnect and exit after an idle policy; it is not a login service, fleet daemon or
second scheduler. CLI owns composition and local IPC; engine owns behavior. Use a protected
local socket/named pipe with bounded versioned frames and same-user access checks. Bind every
command/event to repository, run and protocol identities. Never accept model messages as
operator answers, budget amendments or approvals.

Worker messages include attempt/segment, lease/fencing token, sequence and payload version.
Reject out-of-order, oversized, stale or wrong-owner results. Workers request host-owned tools
through a broker; do not give them database handles. Restrict environment inheritance and keep
provider credentials away from artifact logs and repository commands. Process isolation is for
lifecycle control unless an actual sandbox additionally enforces resource restrictions.

Heartbeats indicate liveness, not authority. On lease loss, revoke the broker grant and terminate
the worker/process group before assigning a replacement writer. Fencing blocks stale commits,
but cannot undo an already running unmediated command; that effect stays uncertain until settled.
Never reassign a mutable workspace solely because a timestamp expired.

Startup recovery checks compatible schema/runtime, reacquires ownership, replays committed
decisions into projections, reconciles worker/process/effect records, and only then dispatches.
Unknown external outcomes block their dependent work with a typed explanation. Cancellation
propagates to every admitted or merely requested descendant; the root is not settled while a
reserved-but-unplanned child or unresolved command remains. Reopening a run cannot reset limits.

## 13. Recursive lifecycle and revision rules

1. Validate a proposed spawn against the current parent revision, frozen delegation ceiling,
   root limits, remaining depth, inputs and required child outputs.
2. Atomically reserve identity/capacity and record spawn intent. Same key replays one decision.
3. Finish and persist the parent's current supported tool exchange; record suspension and
   release execution/writer permits before scheduling descendants.
4. Plan/admit the child under the same root account. Child planning can itself ask an operator
   question, bound to the full graph path and generation.
5. Execute and verify locally. Child-boundary check/review failures receive typed recovery
   dispositions, not a generic catch-all `blocked` result.
6. Persist an immutable child outcome; deliver/consume it once; resume a fresh accounted parent
   segment with refreshed source/grants and supported history. Never replay parent edits.
7. A child node may follow the same flow at depth 2. Grandchild nodes cannot request more graphs.

Child repair, parent adaptation, boundary clarification and cancellation must be implemented
for all supported generations before “recursive mode complete” is recorded. A typed child
failure can reach its parent only after effects/descendants settle and root policy permits
adaptation. Policy denial, root exhaustion and unknown effects cannot be renamed repairable.

Graph revisions use expected-revision compare-and-swap. Executed contracts and receipts remain
historical. Changed node/input contracts invalidate downstream evidence; changed applied writers
require adaptation from current state. Removing a node refunds no lifetime admission. Public
child output contracts, ownership and accepted-result bindings cannot be silently changed.
Initially reject ownership-changing revisions with active descendants rather than inventing a
complex topology migration. Unaffected accepted siblings remain reusable only with valid inputs.

## 14. Context and operator experience

Minimal context contains objective, immutable requirements, applicable instructions, frozen
grants, relevant source/artifact slices, decisions, and acceptance contract. Label source/tool
content as data; it cannot change authority. Keep root, sibling and operator-answer scopes
separate. Persist references for any reduction claimed reversible; logging an omitted name
does not preserve its content. Required obligations must fit or the attempt must narrow/block.

Choose one compaction owner. Start with host-bounded packets and complete tool exchanges;
add tested reductions/portable continuation later. Keep exact route/prompt/tool identity for
compatibility. Do not infer cache residency or financial savings from stable prompts alone.

Planned Pi commands: `/graph on`, `/graph off`, `/graph status`, `/graph pause`, `/graph resume`,
`/graph cancel`, `/graph inspect`, with CLI equivalents and explicit run IDs where needed.
Mode off changes future input routing; it does not cancel active work. Restore by reading
durable status, not submitting the task again. Route only operator input, preserve busy drafts,
and bind answers to the durable pending question. Show why a node waits, retries or stops.

Setup discovers candidate commands as inert repository data, resolves the current/exact model
route, and presents the effective workspace/check/budget policy. Preserve existing mandatory
checks. Reuse authorized configuration without repeated setup dialogs. Provide text-focused
controls first; defer a graph editor or web dashboard.

## 15. Work ordering and delegation

The machine-readable ledger is the canonical dependency DAG. AP-00 records only the verified
scaffold. AP-01 through AP-25 describe unimplemented work; no future capability is marked done.

Start with **AP-01: versioned identities and state/result contracts**. Do not launch workers,
install a database driver or call a provider in that first increment. Then AP-02/AP-03/AP-04
can progress independently with agreed interfaces; integrate before changing shared schemas.

Useful concurrent ownership after contracts stabilize: storage/accounting versus pure engine;
Pi boundary versus isolated worker executor; extension client versus CLI composition. Keep one
writer per file, and let the integrating agent own cross-package contracts and architecture.
Reviewer and focused verifier should consume concrete diffs and evidence. Avoid delegating
unbounded “finish the project” tasks or giving each subagent a different state machine.

Early live qualification is a distinct gate, not a dependency that prevents offline engineering
when credentials/authorization are absent. Record that external prerequisite truthfully. Do
not spend on a broad campaign to compensate for a broken deterministic path. No live run is
authorized solely by this document.

## 16. Evidence and completion contract

Each ledger package has implementation status plus evidence records; qualification is separate.
Allowed statuses: `not_started`, `in_progress`, `partial`, `blocked`, `implemented`. A blocked
entry names a concrete prerequisite and resolution. `implemented` requires its deliverables,
tests and integration acceptance, with exact source identity, command, environment, observed
result, skips and artifact references. Never update status based only on another agent's claim.

Package acceptance covers its owned deliverables and the corresponding slice of a linked
scenario. For example, AP-01 can qualify proposal/acceptance schemas before AP-12 implements
the host gate. Its receipt must identify that limited coverage. A shared AT scenario becomes
verified only after every assertion and required evidence class is covered; scenario links
do not add hidden dependencies that prevent foundational packages from finishing.

Keep classes distinct: static inspection, unit, local integration, process-fault, offline SDK,
live-provider and platform. The [acceptance matrix](acceptance-matrix.md) is a list of obligations,
not a record of executed tests. Historical evidence is immutable; later changes require relevant
new checks. Store concise receipts and summaries, not a giant mutable narrative status file.

Implementation-ready local release means AP-01–AP-15 and AP-17–AP-23 are implemented with
their relevant local assertions, and AP-25 packaging/platform evidence passes for each claimed
platform. All AT scenarios except live AT-40 must be fully verified for that claimed scope.
Full recursive product qualification additionally requires AT-40, AP-24 and its AP-16 live
baseline, under a frozen operator-approved evaluation plan. A green local release may be labeled
local/experimental while live effectiveness remains unqualified; do not hide that distinction.

The final demonstration must create a task graph, spawn a child and grandchild, suspend parents
without deadlock, survive a controlled supervisor kill/restart, settle or explain interrupted
effects, deliver descendants once, adapt to a repairable child-boundary failure, integrate a
candidate, and verify the final tree. Budgets and permissions remain bounded throughout.

Routine checks remain `npm run check` and `npm run demo` until new commands actually exist.
Add named focused/fault/live commands in their owning work packages and document them then.
Do not list aspirational commands as runnable. For this documentation increment, validate links,
ledger IDs/dependencies and consistency; do not claim a fresh runtime qualification.
