# Design

This is the product auto-pi-lot is building toward. In graph mode, you hand the harness a
coding or problem-solving task. It plans a bounded graph of work, runs it through scoped
agents, verifies the results, repairs failures and delivers something you can review.

Most of this is not implemented yet. The document states the contracts, state machines and
behavior the finished system must have. For the code that exists today, see
[architecture.md](architecture.md); for progress, see the [roadmap](roadmap.md) and the
[implementation ledger](implementation-ledger.json).

## Background

Three npm workspaces exist today: `core` (the deterministic, provider-neutral domain), `pi`
(all Pi SDK code), and `cli` (the operator entry point), per
[decision 0004](decisions/0004-three-packages.md). [architecture.md](architecture.md) covers
current code structure, enforced boundaries, and where new code goes; this document does not
repeat it.

This design also builds on a predecessor project, pi-graph. Its
[review](reviews/pi-graph-2026-09-22.md) records source references and verification limits;
the table below translates its lessons into work packages rather than carrying over its
implementation.

| Lesson from pi-graph | Work packages | Adaptation |
| --- | --- | --- |
| Durable intake/clarification identity and identity-preserving graph-mode UX | AP-10, AP-15 | Capture the AP-11 baseline before planning, keep the same root account across answers, preserve unsent input, and do not resubmit on reload. |
| Host-authorized graph contracts and checks | AP-01–AP-03, AP-12 | Separate provisional output from acceptance; close delegation grants by default. |
| Flat scheduler over nested ownership | AP-18–AP-21 | Enforce depth 2 and global permits; a suspended parent must not hold resources its descendants need. |
| Closed SDK resources, exact routes, and final-payload request admission | AP-06, AP-09 | Prove behavior against this repository's pinned SDK, not the predecessor's; include proven-unused release, crash recovery, and explicit usage uncertainty. |
| Transactional state and effect intent | AP-04–AP-08, AP-14 | One SQLite authority; no second LangGraph checkpoint store. |
| Evidence tied to exact candidate inputs | AP-11–AP-13 | Preserve dirty baselines and verify the serially integrated tree. |
| Typed loops and boundary failures | AP-17, AP-21 | Complete child/grandchild repair and clarification; a generic blocked-to-finish route is not enough. |
| Context provenance and reduction | AP-09, AP-22 | Start with minimal bounded packets; retain artifacts for any reduction claimed reversible. |
| Real local effects under fake reasoning, and a large test suite versus useful coding | AP-07–AP-16, AP-24, AP-25 | Use real temporary DB/Git/process fixtures with fault injection and exact-source receipts; measure a small live corpus separately instead of importing broad prompt-search/evaluation machinery. |

auto-pi-lot does not migrate predecessor databases, copy its private local configuration,
preserve its multiple historical hash formats, or transplant its broad evaluation/security
subsystems. It needs one canonical identity format and only the runtime machinery the
acceptance scenarios require. The predecessor's local test suite and two offline bug
reproductions establish only its own reviewed snapshot: they are useful test designs, not
passes for auto-pi-lot.

## Conventions

Changes that alter the semantics in this document need a short ADR in
[docs/decisions/](decisions/) plus matching contract or failure tests. The
[implementation ledger](implementation-ledger.json) tracks status per work package; update an
entry only with evidence tied to the exact source revision that implements it.

## 1. Scope

An operator enables graph mode and gives the harness a task. The harness inspects context,
creates a bounded graph, executes permitted work, verifies outcomes, repairs failures, and
delivers a reviewable result. Eligible nodes can request child graphs, and child nodes can
request grandchildren; the host validates every graph.

v1 must include:

- Durable task intake, planning, clarification, execution, and immutable history.
- One scheduler and one root account spanning all roles and generations.
- Root depth 0, children depth 1, grandchildren depth 2; no delegation beyond depth 2.
- Scoped workers, typed artifacts, host checks, independent review, and serial integration.
- Safe handling of existing user changes, isolated writing workspaces, and bounded commands.
- Restart reconciliation, stale-worker rejection, pause/resume, cancellation, and user steering.
- Pi terminal commands and progress, a CLI, inspectable state, and exportable outcome evidence.
- Deterministic local tests plus a small, separately authorized live task evaluation.

Target repositories are language-agnostic: their own instructions and configured tools/checks
define verification. Non-coding investigations return evidence-bearing artifacts and explicit
uncertainty; they may use a deliberately configured review-only acceptance mode, but a model
must not switch a coding task to review-only to avoid mandatory checks.

v1 excludes remote workers, distributed queues, a fleet daemon, a mutable web dashboard,
unbounded recursive agents, vector/graph databases, automatic deployment or publication,
security research engines, prompt search campaigns, speculative cache warming, and
compatibility with predecessor SQLite databases. None of this is needed to prove the core
workflow.

## 2. Package boundaries and code map

The three packages hold all growing deterministic work; the module list below is where new
code goes, not a proposed future layout. Effect packages are created together with their
first implementation, not declared ahead of a consumer.

| Package | Modules to grow | Responsibility |
| --- | --- | --- |
| `core` | `graph/` (spec, validation); `run/` (state, events, commands, decide, replay, evidence, status, and future scheduler, budget, intake, planning, acceptance, loops, hierarchy, recovery, context, policy modules) | The deterministic, provider-neutral domain: wire schemas, canonical identity, graph admission, the reducer and its extensions, and the session port |
| `pi` | `session`, `map-event`, `extension` | Everything coupled to the Pi SDK: the session adapter and the Pi extension entry point |
| `cli` | `commands`, `composition`, `supervisor`, `ipc`, `inspection` | Resource composition, local supervisor startup, and the operator CLI |

Future effect packages, created together with their first implementation:

| Package | First owner | Responsibility |
| --- | --- | --- |
| `storage` | AP-04 (backend decision), AP-05 (implementation) | Transactional state/journal implementation and immutable artifact storage |
| `worker` | AP-08 (protocol/process/broker), AP-11 (workspace/commands), AP-13 (integration) | Worker process lifecycle and the host-owned effect executor; workers request effects through the broker |

`core` is the lowest package and depends on no workspace. `pi` and `cli` depend on `core`;
`pi` imports only the `@auto-pi-lot/core/session` subpath, never the full domain, so
SDK-coupled code cannot reach into run decisions. A port interface — a journal store, a
worker dispatcher — is added to `core` in the same change as its first implementation, shaped
by what the reducer and that implementation actually need
([decision 0004](decisions/0004-three-packages.md)). Storage and worker, once created,
implement the ports `core` declares for them, avoiding a catch-all mutable Controller or
passing a whole store to every component. Pi SDK imports stay inside `pi`; the deterministic
reducer holds no adapter import or database handle. Biome enforces these boundaries
(`noUndeclaredDependencies`, `noRestrictedImports`, `noImportCycles`); see
[architecture.md](architecture.md).

## 3. State authority and protocol identities

SQLite is authoritative for run decisions, graph revisions, attempts, reservations, leases,
effects, and accepted evidence. Pi transcripts are conversation history. Artifact files are
immutable payloads addressed by digest. UI status and scheduler queues are rebuildable views.
There is one state owner; the initial engine has no additional LangGraph checkpoint system.

Wire schemas, database migrations, and executable compatibility each keep independent version
numbers. Graph revision is plan content history, not a schema version. Tool/prompt contract
identity is added when sessions run; cache identity is added only when caching needs it. The
legacy graph/schema/runtime version numbers and its 19 migrations do not carry over into a
fresh database.

Run, graph instance, node, attempt, request, event, and artifact each get a stable generated
ID. Scoped keys are stored as tuples, not ambiguous string concatenations. A graph instance
keeps its identity across revisions. Each actual execution gets a new attempt and segment
identity. Retries use idempotency keys bound to the full canonical request; the same key with
different content is a conflict, not permission to overwrite history.

New persisted identities need one canonical JSON representation: DTOs are validated first,
unsupported values are rejected, optional-field/array/number behavior is defined, object keys
sort deterministically, and test vectors are maintained. Historical hash algorithms are
irrelevant unless an explicit import feature is authorized later.

## 4. Contracts

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

Strict schema parsing precedes semantic checks. Validation must prove graph-local DAGs, owner
existence, depth increments, unique identities, requirement coverage, declared artifact
dependencies, authorized roles/models/checks, scope narrowing, and reachable acceptance.
Cross-graph data travels only through declared immutable bindings. An ancestor-completion
dependency cannot be introduced into its own child. No model output changes root requirements
or policy.

Operator steering works differently: it persists an explicit amendment, pauses affected
dispatch, invalidates stale contracts/evidence, and revises deliberately. History preserves
the original objective and prior decisions. New text during a run is not automatically a
replacement task.

## 5. Execution and acceptance are separate

The scaffold currently unlocks every edge only on `accepted`. That does not work once
verification is a real downstream node: implementation must not be marked accepted merely to
let its verifier start.

The design uses a dependency condition and two related state dimensions:

- Execution: `pending`, `ready`, `running`, `waiting_children`, `waiting_input`,
  `waiting_approval`, `result_ready`, `failed`, `cancelled`, `exhausted`.
- Acceptance for a result: `unverified`, `verifying`, `accepted`, `rejected`, `invalidated`.

A verifier or check consumes provisional output through an explicit `result_ready` edge. A
task that requires trusted output consumes an `accepted` edge instead. The host's acceptance
gate updates the result disposition once its required receipts exist; this is not a cyclic
graph dependency. Child failure continuation uses a typed terminal-outcome binding, never a
fabricated success.

The run lifecycle is `planning → running → verifying → succeeded`, with explicit waiting,
paused, blocked, and terminal failed/cancelled/exhausted outcomes. `blocked` is nonterminal:
it carries a typed reason plus a permitted resolution, and it is not another word for failed.
Pausing stops new dispatch and waits for a documented safe checkpoint. Cancellation stops the
subtree, reconciles in-flight work, and becomes terminal; an ordinary resume does not undo
it. An explicitly requested successor run records lineage and a newly authorized budget.

Graph instance completion requires settled descendants, effects, output contracts, and local
acceptance. Root completion additionally requires integration and the current mandatory final
checks/review. A worker process exit, a Pi settled event, or one passing isolated check
cannot by itself make the root succeed.

## 6. Scheduler, roles, and loops

One global scheduler owns the runnable set. It starts sequentially, adds parallel immutable
readers, and adds isolated writers only after integration tests pass. Suggested defaults: 4
active sessions, 24 lifetime admitted nodes, depth 2, 2 repair rounds per task, and 2 major
replans. Explicit run configuration must also resolve a global semantic-repair cap,
request/tool/token limits, and a deadline before dispatch. These exported defaults are not
enforcement by themselves.

Runnable admission checks the dependency condition, current revision, grants, budget,
cancellation, workspace ownership, and available permits. Ordering is deterministic, with
bounded fair queues; the scheduler does not add cost-prediction scheduling initially. Waiting
parents release their model/process permits and any write lease their descendants need: their
continuation persists first, then the session is disposed or parked without retaining a
worker slot. Active child processes and queued nodes stay bounded.

| Role | Model work | Host boundary |
| --- | --- | --- |
| Planner | Decomposition and graph/revision proposals | Read-only discovery and validated submission |
| Explorer | Bounded source investigation or hypothesis testing | Scoped reads/search and artifact return |
| Implementer | Candidate edits and repair | Workspace-specific writes and allowed command/check requests |
| Verifier | Interpret evidence, identify missing coverage when useful | Actual check execution is a deterministic check node |
| Reviewer | Independent criterion assessment | Reads candidate and evidence; cannot edit its way to a pass |
| Integrator | Resolve patch interaction when reasoning is needed | Host applies/stages candidates serially and runs final checks |

Roles are profiles, not permanent agents. A node may coordinate its own child graph within
the same explicit delegation grant. Mechanical joins, checking, accounting, and scheduling do
not need model calls; a one-node graph is valid for a small task.

Transport retry, schema repair, semantic repair, investigation, continuation, and replan stay
distinct policies with distinct counters. Each loop records the failure identity, the
proposed change or hypothesis, the expected observation, and the remaining allowance. A loop
that keeps repeating the same outcome stops. Counters must not reset on compaction, child
creation, restart, or an unrelated sibling's success; adapting after a failed child is itself
a root semantic-repair debit.

## 7. Budget and provider request lifecycle

The system maintains one conserved root account. Child slices are earmarks or ceilings within
it, not new money or tokens. A nested request reservation transfers from an earmark; it must
not be charged twice as both a full child reserve and a separate root reserve. Reservation
changes persist atomically with admission, and the system must always hold
`spent + outstanding reservations <= authorized limit`. Only unused reservations are
returned; settled usage, failed attempts, and lifetime node admission are not refunded.
Completion capacity is reserved for required checking, review, and integration.

Before every provider request, the harness checks the actual serialized payload bounds, exact
route, output cap, request count, deadline, cancellation, and account availability.
Unaccounted SDK retries are disabled. The pinned Pi SDK needs a supported request hook, and
that hook must be proven to run before transport; if that boundary cannot be enforced, the
affected capability is blocked rather than assumed controlled.

```text
reserved -> released_not_dispatched     proven no transport dispatch
reserved -> dispatch_intent             persisted before transport can begin
dispatch_intent -> settled              qualified outcome/usage receipt
dispatch_intent -> uncertain            outcome or usage cannot be established
uncertain -> reconciled                 explicit validated resolution
```

Only a fenced owner with proof that dispatch was not possible may release a reservation. For
a crash in `reserved` before `dispatch_intent`, recovery must revoke or settle the previous
owner, confirm its process cannot dispatch, and verify the durable no-intent invariant under
the qualified request protocol; only then can it release, exactly once. If protocol
compatibility or dispatch history cannot be established, explicit reconciliation is required
instead of a guess. This crash case is tested separately from a live cancellation; absence of
a completion receipt after a crash is not proof of no dispatch. A crash after dispatch intent
but before the actual network request can legitimately stay uncertain. Cancellation, deadline
expiry, or a manifest-write failure before dispatch intent must release the reservation once
and leave the run usable. This is a mandatory regression test for a confirmed predecessor
defect.

Unknown usage is not zero. Raw bounded observation metadata and qualification are persisted
separately from accounting estimates; credentials and unnecessary provider payloads are not
retained. An enabled monetary hard cap needs usable route pricing/reservation rules. A
request-limited mode can operate without exact cost reporting, but it must label cost unknown
and still enforce its other limits. Disabling or raising limits requires an operator
amendment; model output cannot do it.

Reservation bounds must cover the supported route's possible request/output usage. If
observed usage exceeds a bound anyway, the system records the actual overrun and stops new
admission for reconciliation; it must never clamp usage or fabricate account conservation. A
local admission limit does not guarantee a provider's billing behavior, so hard-cap claims
are qualified by the enforced dimensions and the supported route's reservation guarantees.

## 8. Storage: SQLite, artifacts, and migrations

AP-04 makes a bounded backend decision: direct SQLite versus available Pi durable storage,
evaluated against transaction, migration, fencing, backup, runtime, and failure-test needs.
The application port stays stable regardless of that choice; this must not become a general
database framework. No backend is selected merely by being mentioned in earlier discussions.

Target tables/collections: runs and amendments; graph instances/revisions; node revisions;
attempts/segments; journal events; artifacts and references; check/review/acceptance
receipts; accounts/reservations/usage; spawn/suspension/delivery records; worker leases;
effects; questions/answers and operator commands. Invariants that must commit atomically are
co-located.

Required constraints: unique scoped identities, immutable artifact/revision content,
idempotent command keys, compare-and-swap on the current revision, ordered events, and
fencing checks. Task request lookup, ready/waiting projections, graph ownership, unresolved
effects, and account summaries are indexed. Admission does not scan all retained runs or
usage rows.

The design uses local SQLite in WAL mode with an explicit durability/backup policy,
preferring durable acknowledged control commits and documenting any weaker setting. No
transaction stays open while calling a provider, running a command, or waiting for a child:
intent is persisted, the effect performed, then settled in a new short transaction. Atomicity
is never claimed across database and filesystem.

Artifacts: bytes are written to a temporary file, hashed, flushed, and atomically installed
as a blob, then the reference is committed. Digest and size are verified on retrieval. An
interrupted write may leave an unreferenced blob for later collection, not a valid receipt
pointing at absent bytes. Active attempts, child deliveries, and unresolved effects are
protected from retention/GC. Backups cover the database and all referenced blobs together,
with restore tested; copying an open DB file alone is not a backup procedure. Migrations are
ordered, transactional where supported, and checksum-bound.

## 9. Workspace and command execution

The baseline capture is reproducible and includes staged, unstaged, and untracked operator
work, without reset/stash and without overwriting it. File modes, deletions, symlinks, and
relevant exclusions are preserved. Workspace identity includes the baseline revision plus
content, not a commit ID alone. Secret or untracked ignored files must not go silently into
task packets or artifacts; exclusions are recorded explicitly. If required inputs cannot be
captured under current policy, the baseline requirement is resolved before planning rather
than treating an incomplete snapshot as complete.

The design uses a run integration workspace and task workspaces. One writer holds each
workspace lease, and every concurrent writer gets a separate worktree. Read-only concurrency
uses immutable snapshots or validated read sets, never a mutable tree being edited elsewhere.
Sharing a parent workspace with a child needs an explicit lease handoff; otherwise the child
forks from an identified parent snapshot.

Workers return candidate changes against a base fingerprint. The host applies them serially
to the integration workspace, records conflicts and their resolution, and reruns required
checks on the combined tree: patches that pass individually are not accepted collectively.
Delivery is a branch/patch plus an evidence report; modifying the user's checkout is a
separate authorized action with drift checks. Graph completion alone must not trigger
automatic commits, pushes, publication, or deployment.

File mutation tools bind to expected preimages, so stale edits fail. Effect intent and the
postimage/receipt are recorded. Recovery verifies current bytes before deciding whether an
edit happened. Arbitrary command replay needs effect-specific idempotency or reconciliation.
Checks bind executable/argument/profile/environment/input identity, a timeout, and an
observable exit status; parser-supported test counts are distinct from exit-code-only
reports.

Initial command access goes through configured profiles and argument arrays. Existing
authorized checks do not prompt on every call; new authority or an irreversible action
follows the configured operator boundary. An unrestricted shell, if explicitly enabled,
carries real host authority: path globs cannot confine it, and a worktree or `shell: false`
is not an OS sandbox. v1 supports trusted local repository processes and says so;
hostile-workload isolation is separate work.

## 10. Worker processes, supervisor, and recovery

One supervisor starts on demand for a canonical repository/store identity. It may survive a
Pi UI disconnect and exit under an idle policy; it is not a login service, a fleet daemon, or
a second scheduler. The CLI owns composition and local IPC; the engine owns behavior. IPC
uses a protected local socket or named pipe with bounded versioned frames and same-user
access checks. Every command/event binds to repository, run, and protocol identities. Model
messages are never accepted as operator answers, budget amendments, or approvals.

Worker messages carry attempt/segment, lease/fencing token, sequence, and payload version.
Out-of-order, oversized, stale, or wrong-owner results are rejected. Workers request
host-owned tools through a broker; they never get database handles. Environment inheritance
is restricted, and provider credentials stay out of artifact logs and repository commands.
Process isolation is for lifecycle control unless an actual sandbox additionally enforces
resource restrictions.

Heartbeats indicate liveness, not authority. On lease loss, the broker grant is revoked and
the worker/process group is terminated before a replacement writer is assigned. Fencing
blocks stale commits but cannot undo an already running unmediated command; that effect stays
uncertain until settled. A mutable workspace is never reassigned solely because a timestamp
expired.

Startup recovery checks compatible schema/runtime, reacquires ownership, replays committed
decisions into projections, reconciles worker/process/effect records, and only then
dispatches. Unknown external outcomes block their dependent work with a typed explanation.
Cancellation propagates to every admitted or merely requested descendant; the root is not
settled while a reserved-but-unplanned child or an unresolved command remains. Reopening a
run does not reset limits.

## 11. Recursive lifecycle and revisions

A child spawn follows this sequence:

1. Validate the proposed spawn against the current parent revision, frozen delegation
   ceiling, root limits, remaining depth, inputs, and required child outputs.
2. Atomically reserve identity/capacity and record spawn intent; the same key replays one
   decision.
3. Finish and persist the parent's current supported tool exchange, record suspension, and
   release execution/writer permits before scheduling descendants.
4. Plan/admit the child under the same root account. Child planning can itself ask an
   operator question, bound to the full graph path and generation.
5. Execute and verify locally. Child-boundary check/review failures get a typed recovery
   disposition, not a generic catch-all `blocked` result.
6. Persist an immutable child outcome, deliver/consume it once, and resume a fresh accounted
   parent segment with refreshed source/grants and supported history. Parent edits are never
   replayed.
7. A child node can follow the same flow at depth 2. Grandchild nodes cannot request further
   graphs.

Child repair, parent adaptation, boundary clarification, and cancellation must be implemented
for every supported generation before recursive mode is considered complete. A typed child
failure can reach its parent only after effects/descendants settle and root policy permits
adaptation. Policy denial, root exhaustion, and unknown effects are never relabeled as
repairable.

Graph revisions use expected-revision compare-and-swap. Executed contracts and receipts stay
historical. Changed node/input contracts invalidate downstream evidence; changed applied
writers require adaptation from current state. Removing a node refunds no lifetime admission.
Public child output contracts, ownership, and accepted-result bindings cannot change
silently. Revisions that would change ownership with active descendants are rejected
initially, rather than inventing a complex topology migration. Unaffected accepted siblings
stay reusable only with valid inputs.

## 12. Context and operator experience

Minimal context contains the objective, immutable requirements, applicable instructions,
frozen grants, relevant source/artifact slices, decisions, and the acceptance contract.
Source or tool content is labeled as data; it cannot change authority. Root, sibling, and
operator-answer scopes stay separate. References are persisted for any reduction claimed
reversible; logging an omitted name does not preserve its content. If required obligations do
not fit, the attempt narrows or blocks.

One compaction owner is chosen. The design starts with host-bounded packets and complete tool
exchanges, then adds tested reductions and portable continuation later. Exact route/prompt/
tool identity is kept for compatibility; cache residency or financial savings are never
inferred from stable prompts alone.

Planned Pi commands: `/graph on`, `/graph off`, `/graph status`, `/graph pause`,
`/graph resume`, `/graph cancel`, `/graph inspect`, with CLI equivalents and explicit run IDs
where needed. Turning the mode off changes future input routing; it does not cancel active
work. Restoring a session reads durable status rather than resubmitting the task. Only
operator input is routed, busy drafts are preserved, and answers bind to the durable pending
question. The UI shows why a node waits, retries, or stops.

Setup discovers candidate commands as inert repository data, resolves the current/exact model
route, and shows the effective workspace/check/budget policy. Existing mandatory checks are
preserved. Authorized configuration is reused without repeated setup dialogs. Text-focused
controls come first; a graph editor or web dashboard is deferred.

## 13. Sequencing

The [implementation ledger](implementation-ledger.json) is the canonical dependency DAG.
AP-00 records the verified scaffold only; AP-01 through AP-25 describe unimplemented work,
and no future capability is marked done.

Work starts with **AP-01: versioned identities and state/result contracts**, which needs no
worker, database driver, or provider call in its first increment. AP-02, AP-03, and AP-04 can
then progress independently against agreed contracts, integrating before shared schemas
change.

Early live qualification (AP-16) is a distinct gate, not a dependency that blocks offline
engineering when credentials or authorization are absent; that external prerequisite is
recorded truthfully rather than compensated for with a broad campaign. No live run is
authorized solely by this document.

## 14. Completion criteria

Each ledger package carries an implementation status plus evidence records; live
qualification is tracked separately. A local, implementation-ready release means AP-01–AP-15
and AP-17–AP-23 are implemented with their relevant local assertions, and AP-25
packaging/platform evidence passes for each claimed platform. Every
[acceptance-matrix](acceptance-matrix.md) scenario except live AT-40 must be fully verified
for that claimed scope.

Full recursive product qualification additionally requires AT-40, AP-24, and its AP-16 live
baseline, run under a frozen, operator-approved evaluation plan. A green local release can be
labeled local/experimental while live effectiveness stays unqualified; that distinction is
not hidden.

The final demonstration must create a task graph, spawn a child and a grandchild, suspend
parents without deadlock, survive a controlled supervisor kill/restart, settle or explain
interrupted effects, deliver descendants once, adapt to a repairable child-boundary failure,
integrate a candidate, and verify the final tree, with budgets and permissions bounded
throughout.

Routine checks are `npm run check` and `npm run demo` until new commands exist. Named
focused/fault/live commands are added and documented in their owning work packages.
