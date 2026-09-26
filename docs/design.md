# Design

**In short.** This is the product auto-pi-lot is building toward, and most of it is not built
yet. In graph mode you give the harness a coding or problem-solving task. It plans a bounded
plan of work (a *task graph*), runs the tasks through AI agents with narrow permissions,
verifies the results with non-AI checks, repairs failures within fixed limits, and delivers
something you can review. Three ideas run through the whole design: a model's report is only
a proposal until the host accepts it with evidence; one budget and one scheduler cover the
entire run, however deeply tasks are nested; and after any crash the system either knows what
happened or says explicitly that it does not. [Design: intro, §1, §5, §7, §10]

*About this page.* It is a plain-language edition of the design document for engineers and
engineering leads who want to understand what the finished product will do and what it
promises, without knowing distributed-systems vocabulary. Section numbers (§1 to §14) are
unchanged, and code names stay in `code font` so the page still maps onto the source.
Bracketed references such as [Design §7] point to the section of the original document this
edition was rewritten from; the originals are in the Git history at commit `bf04bd0`. Terms
in *italics* on first use are defined in the [glossary](#glossary).

This page states the rules, data formats and behaviour the finished system must have. For the
code that exists today, see [architecture](architecture.md); for progress, see the
[roadmap](roadmap.md) and the [implementation ledger](implementation-ledger.json).

## The design at a glance

- **Proposals versus decisions.** Workers propose results; only the host's *acceptance gate*,
  citing recorded evidence, accepts them. A task that checks another task's output may start
  on the unaccepted result; a task that needs trusted input waits for acceptance. [§5]
- **Findings repair the producer.** When a check or a falsifier finds a defect, the task that
  produced the result gets a new, bounded attempt with the findings attached, and everything
  built on the old result is redone. [Decision 0005]
- **One of everything that must not be duplicated.** One scheduler decides what runs; one
  root budget pays for everything, including sub-plans; one database is the authority on
  state. [§3, §6, §7]
- **Bounded nesting.** A task may start a sub-plan (a *child*), and a child task may start one
  more level (a *grandchild*). Nothing deeper is allowed. [§1, §11]
- **Honest about uncertainty.** Unknown model usage is never recorded as zero; an action whose
  outcome a crash made unknowable is marked uncertain and reconciled, never assumed. [§7, §10]
- **Your work is protected.** Uncommitted changes in your checkout are captured, never
  discarded; results arrive as a branch or patch plus evidence, not as silent commits. [§9]
- **Not a sandbox.** Separate working copies keep parallel writers apart, but they do not
  contain a hostile program; version 1 supports trusted local repositories only. [§9]

## Background

Three packages exist today: `core` (the deterministic decision logic, independent of any
model provider), `pi` (all code that uses the Pi software development kit, or SDK) and `cli`
(the operator's entry point), per [decision 0004](decisions/0004-three-packages.md). The
[architecture page](architecture.md) covers the current code, the enforced boundaries and
where new code goes; this page does not repeat it. [Design: Background]

The design also builds on a predecessor project, *pi-graph*. Its
[review](reviews/pi-graph-2026-09-22.md) records the sources examined and the limits of that
review. The table below turns its lessons into *work packages* (numbered units of planned
work, AP-xx) instead of copying its code. [Design: Background]

| Lesson from pi-graph | Work packages | How auto-pi-lot applies it |
| --- | --- | --- |
| A task's identity must survive intake and clarification, and the graph-mode interface must not lose it | AP-10, AP-15 | Capture the starting state of the repository (from AP-11) before planning, keep the same root budget across the operator's answers, keep unsent input, and never resubmit on reload. |
| Plans and checks must be authorised by the host | AP-01 to AP-03, AP-12 | Keep provisional output separate from accepted output; give sub-plans no permissions unless explicitly granted. |
| One flat scheduler over nested ownership | AP-18 to AP-21 | Enforce a maximum depth of 2 and a global limit on running work; a paused parent must not hold resources its descendants need. |
| The SDK's resources must be closed off, routes exact, and each final request checked before sending | AP-06, AP-09 | Prove the behaviour against this repository's pinned SDK, not the predecessor's, including releasing budget that was provably unused, crash recovery and explicitly unknown usage. |
| State changes and intended actions must be saved together | AP-04 to AP-08, AP-14 | One SQLite database is the authority; no second checkpoint store (such as LangGraph's). |
| Evidence must be tied to the exact inputs it checked | AP-11 to AP-13 | Keep the user's uncommitted changes in the baseline, and verify the code after merging, one change at a time. |
| Loops and failures at boundaries need specific types | AP-17, AP-21 | Finish repair and clarification for children and grandchildren; a generic "blocked, so finish" path is not enough. |
| What a model is shown must keep its sources and be reduced carefully | AP-09, AP-22 | Start with small, bounded packets of context; keep stored files for any reduction that is claimed to be reversible. |
| Real local effects with fake reasoning; a large test suite is not the same as useful coding | AP-07 to AP-16, AP-24, AP-25 | Test with real temporary databases, Git repositories and processes, with injected faults and receipts tied to exact source versions; measure a small set of real tasks separately rather than adopting broad prompt-search and evaluation machinery. |

auto-pi-lot does not migrate the predecessor's databases, copy its private local
configuration, keep its several historical hash formats, or bring over its broad evaluation
and security subsystems. It needs one canonical identity format and only the runtime
machinery the [acceptance scenarios](acceptance-matrix.md) require. The predecessor's local
test suite and two offline bug reproductions only establish facts about the predecessor's
reviewed snapshot: they are useful designs for tests, not passes for auto-pi-lot. [Design:
Background]

## Conventions

A change to the behaviour described here needs a short decision record (ADR) in
[docs/decisions/](decisions/) and matching tests of the data format or failure. The
[implementation ledger](implementation-ledger.json) tracks status per work package; an entry
is updated only with evidence tied to the exact source version that implements it. [Design:
Conventions]

## 1. Scope

An operator switches on graph mode and gives the harness a task. The harness looks at the
context, creates a bounded plan, carries out the permitted work, verifies the outcomes,
repairs failures and delivers a result that can be reviewed. Suitable tasks can ask for a
sub-plan (child graph), and child tasks can ask for one more level (grandchildren); the host
checks every plan. [§1]

Version 1 must include:

- Saved (*durable*) task intake, planning, clarification, execution and a history that cannot
  be edited.
- One scheduler and one root budget covering all roles and all levels of nesting.
- Root at depth 0, children at depth 1, grandchildren at depth 2; no delegation beyond
  depth 2.
- Workers with narrow permissions, typed stored results (*artifacts*), checks run by the host,
  independent review, and merging changes one at a time.
- Safe handling of changes the user already made, separate workspaces for writers, and limited
  commands.
- Reconciliation after a restart, rejection of stale workers, pause and resume, cancellation,
  and steering by the user.
- Pi terminal commands and progress display, a command-line tool, inspectable state and
  exportable evidence of the outcome.
- Deterministic local tests, plus a small, separately authorised evaluation on real tasks.

[§1]

The target repositories can be in any language: their own instructions and configured tools
and checks define what "verified" means. Investigations that are not about code return
evidence-bearing artifacts and state their uncertainty explicitly. They may use a deliberately
configured review-only acceptance mode, but a model must not switch a coding task to
review-only to avoid mandatory checks. [§1]

Version 1 excludes: remote workers, distributed queues, a fleet-wide background service, a web
dashboard for editing, unbounded recursive agents, vector or graph databases, automatic
deployment or publication, security-research engines, prompt-search campaigns, speculative
cache warming, and compatibility with the predecessor's SQLite databases. None of these is
needed to prove the core workflow. [§1]

## 2. Package boundaries and code map

The three existing packages hold all growing deterministic work. The list below says where
new code goes; it is not a proposed future layout. Packages that act on the outside world
(*effect* packages) are created together with their first implementation, not declared ahead
of anything that uses them. [§2]

| Package | Modules to grow | Responsible for |
| --- | --- | --- |
| `core` | `graph/` (plan format, checking); `run/` (state, events, commands, `decide`, `replay`, evidence, status, and later the scheduler, budget, intake, planning, acceptance, loops, nesting, recovery, context and policy modules) | The deterministic, provider-neutral core: data formats, canonical identities, plan admission, the *reducer* and its extensions, and the session interface |
| `pi` | `session`, `map-event`, `extension` | Everything tied to the Pi SDK: the session adapter and the Pi extension entry point |
| `cli` | `commands`, `composition`, `supervisor`, `ipc`, `inspection` | Wiring the parts together, starting the local *supervisor*, and the operator's command-line tool |

Future effect packages, each created with its first implementation:

| Package | First owner | Responsible for |
| --- | --- | --- |
| `storage` | AP-04 (backend decision), AP-05 (implementation) | Saving state and the event log in transactions, and storing artifacts that never change |
| `worker` | AP-08 (protocol, processes, broker), AP-11 (workspaces, commands), AP-13 (merging) | Worker process lifecycle and the host-owned executor of actions; workers ask the *broker* for actions instead of acting directly |

`core` is the lowest package and depends on no other package in the repository. `pi` and
`cli` depend on `core`; `pi` sees only the session part of `core` (`@auto-pi-lot/core/session`),
never the whole, so SDK-specific code cannot reach into run decisions. An interface to an
effect (a *port*), such as a journal store or a worker dispatcher, is added to `core` in the
same change as its first implementation and shaped by what the reducer and that
implementation actually need ([decision 0004](decisions/0004-three-packages.md)). Once they
exist, `storage` and `worker` implement the ports `core` declares for them. This avoids one
all-purpose, changeable "controller" object and avoids handing the whole database to every
component. Pi SDK imports stay inside `pi`; the deterministic reducer holds no adapter import
and no database handle. The Biome linter enforces these boundaries
(`noUndeclaredDependencies`, `noRestrictedImports`, `noImportCycles`); see
[architecture](architecture.md). [§2]

## 3. Who holds the truth, and how things are identified

SQLite is the authority for run decisions, plan revisions, attempts, budget reservations,
*leases*, actions on the outside world and accepted evidence. Pi's transcripts are
conversation history, not authority. Artifact files are unchangeable content addressed by
their hash (*digest*). Status in the interface and the scheduler's queues are views that can
be rebuilt. There is one owner of state; the first version of the engine has no additional
checkpoint system such as LangGraph's. [§3]

Three version numbers are kept independent: that of the data formats sent between parts, that
of the database structure (its *migrations*), and that of the program's compatibility. A
*graph revision* is the history of a plan's content, not a format version. Identities for tool
and prompt contracts are added when sessions run; cache identities are added only when caching
needs them. The predecessor's plan, format and runtime version numbers, and its 19 database
migrations, do not carry over into a new database. [§3]

Runs, plan instances, tasks, attempts, requests, events and artifacts each get a stable
generated ID. Keys made of several parts are stored as separate fields, not glued into strings
that could be read more than one way. A plan instance keeps its identity across revisions.
Every actual execution gets a new attempt and segment identity. Retries use *idempotency keys*
(request keys that make repeating a request safe) bound to the full canonical request; the same
key with different content is a conflict, not permission to overwrite history. [§3]

Every newly saved identity needs one canonical JSON form: data is validated first, unsupported
values are rejected, the handling of optional fields, arrays and numbers is defined, object
keys are sorted deterministically, and test vectors are maintained. The predecessor's hash
algorithms do not matter unless an import feature is explicitly authorised later. [§3]

## 4. Data formats (contracts)

Each *contract* below is a data format with required content. [§4]

| Contract | What it must contain or guarantee |
| --- | --- |
| `RunSpec` | The objective, IDs of the root requirements (which cannot change), the starting state (*baseline*), a reference to the policy, the budget, and the identity of the task request |
| `RunAmendment` | An explicit change by the operator: the previous revision, the changed requirements or scope, proof of authorisation, and the work that is no longer valid |
| `GraphRevision` | Plan and run identity, revision number, which task owns the plan, depth, tasks and dependencies, and the unchangeable contracts for inputs from and outputs to the outside |
| `NodeSpec` | A task's kind, objective, requirements, role where needed, inputs and outputs, acceptance gate, granted permissions, limits and an explicit ceiling on further delegation |
| `Dependency` | Which task produces, which consumes, the artifact passed between them, and the required condition: `result_ready` (needs a result) or `accepted` (needs an accepted result) |
| `WorkerAssignment` | Attempt, segment and revision; the *fencing token*; the workspace and its base; the exact model *route*; frozen permissions and context; and a deadline |
| `ResultProposal` | What the worker claims, its output artifact IDs, limitations, declared changes and requested checks; it cannot claim that the host accepted it |
| `CheckReceipt` | The check profile and its version, the identity of the executable and its arguments, the environment, the digest of inputs and source, the exit status or outcome, the test count where the tool reports one, and log artifacts |
| `ReviewReceipt` | The candidate reviewed, a verdict per criterion, evidence IDs and limitations; a model's judgement stays distinguishable from measured checks |
| `AcceptanceRecord` | The host's decision, a fingerprint of the candidate and its inputs, the required receipts, the policy or revision that decided, and whether it has since been invalidated |
| `SpawnRequest` | The parent plan, task and attempt; the reason; the request identity; the narrowed permissions; inputs; output contracts; the child's ceiling; and the remaining depth |
| `SuspensionRecord` | The parent's completed exchange with the model, a saved reference for continuing it, the capacity it released, and the child's request identity |
| `ChildResult` | The outcome (accepted, failed, cancelled or exhausted), outputs bound to their contracts, check and review evidence, unresolved issues and the budget consumed |
| `EffectRecord` | The identity of the intended action, the expected state before it, its type, whether it was dispatched, received or reconciled, and whether it can be recovered |
| `JournalEvent` | Version and type, position in the sequence, the run and the full plan, task and attempt identity, the command that caused it, and a limited, typed payload |

Strict format checking comes before checking for meaning. Plan checking must prove that each
plan has no circular dependencies (it is a *DAG*), that owners exist, that depth increases by
one per level, that identities are unique, that requirements are covered, that declared
artifact dependencies exist, that roles, models and checks are authorised, that permissions
only narrow, and that acceptance is reachable. Data crosses between plans only through
declared, unchangeable bindings. A child cannot be made to depend on its own ancestor's
completion. No model output changes the root requirements or the policy. [§4]

Operator steering works differently: it saves an explicit amendment, pauses the affected work,
invalidates contracts and evidence that are now stale, and revises deliberately. The history
keeps the original objective and earlier decisions. New text typed during a run is not
automatically treated as a replacement task. [§4]

## 5. Running a task and accepting its result are separate

> **Note on a statement that is out of date.** The original says: "The scaffold currently
> unlocks every edge only on `accepted`." That described the earlier scaffold. The current
> reducer already supports both conditions, `result_ready` and `accepted`
> [Architecture: What runs today; README: How it works]. The design requirement below is
> unchanged.

Unlocking every dependency only on acceptance does not work once verification is a real task
downstream: the implementation would have to be marked accepted just so its verifier could
start, which defeats the point of verifying. [§5]

The design therefore uses a condition on each dependency, and two separate dimensions of
state. [§5]

- **Execution** (how far the task has got): `pending`, `ready`, `running`,
  `waiting_children`, `waiting_input`, `waiting_approval`, `result_ready`, `failed`,
  `cancelled`, `exhausted`.
- **Acceptance** (how far its result is trusted): `unverified`, `verifying`, `accepted`,
  `rejected`, `invalidated`.

A verifier or check uses provisional output through an explicit `result_ready` dependency. A
task that needs trusted output uses an `accepted` dependency instead. The host's acceptance
gate updates the result's acceptance state once the required receipts exist; this is not a
circular dependency in the plan. When a child fails, the parent continues through a typed
binding to that final outcome, never through an invented success. [§5]

A task that reads a producer's result through a `result_ready` dependency is a *verifying node*
of that producer. The producer is accepted only after every verifying node has accepted
evidence about its current result, and a plan in which a verifying node also waits for the
producer's acceptance is rejected, because neither could ever start. A failing finding rejects
the producer, not the task that found it. The producer then gets a new attempt that carries the
failing receipts. Every task that used the rejected result, and everything built on those, is
cancelled or marked `invalidated` and runs again against the new result; these re-runs do not
use up the verifying nodes' own retries. A failing deterministic check rejects the producer on
its own. A model's judgment does not: a `fail` or `unclear` review leads to a fresh independent
review of the same result, and only two reviews that agree settle it. A counterexample that
caused a rejection becomes a required check for every later attempt of that producer.
[Decision 0005]

A run moves through `planning → running → verifying → succeeded`, with explicit waiting,
paused and blocked states, and the final outcomes failed, cancelled and exhausted. `blocked` is
not final: it carries a typed reason and a permitted way to resolve it, and it is not another
word for failed. Pausing stops new work from starting and waits for a documented safe point.
Cancellation stops the whole subtree, reconciles work that was in progress and is final; an
ordinary resume does not undo it. A follow-up run that is explicitly requested records where
it came from and gets a newly authorised budget. [§5]

A plan instance is complete only when its descendants, its actions on the outside world and
its output contracts are settled and its own results accepted. The root additionally needs the
merged result and the current mandatory final checks and review. A worker process exiting, Pi
reporting that it has settled, or one isolated check passing cannot on its own make the root
succeed. [§5]

## 6. Scheduler, roles and loops

One global scheduler owns the set of work that is ready to run. It starts by running tasks one
after another, then adds parallel readers of unchangeable data, and adds isolated parallel
writers only once the merge tests pass. **Suggested** defaults are: 4 active sessions, 24 tasks
admitted over a run's lifetime, depth 2, 2 repair rounds per task, and 2 major re-plans. The
run's explicit configuration must also settle, before anything starts, a global cap on
semantic repairs, limits on requests, tool calls and tokens, and a deadline. These exported
defaults do not enforce anything by themselves. [§6]

Before a task may start, the scheduler checks the dependency condition, the current revision,
permissions, budget, cancellation, workspace ownership and free slots. The order is
deterministic, with bounded fair queues; there is no scheduling by predicted cost at first.
Parents that wait release their model and process slots and any write lease their descendants
need: their continuation is saved first, then the session is closed or parked without keeping
a worker slot. The number of active child processes and queued tasks stays bounded. [§6]

| Role | What the model does | Where the host draws the line |
| --- | --- | --- |
| Planner | Breaks work down and proposes plans or revisions | Read-only discovery; plans are submitted for checking |
| Explorer | Bounded investigation of sources or testing of a hypothesis | Reads and searches within its scope; returns artifacts |
| Implementer | Proposes edits and repairs | Writes only in its own workspace; may request allowed commands and checks |
| Verifier | Interprets evidence and points out missing coverage where useful | Actually running the check is a separate deterministic check task |
| Falsifier | Tries to break the candidate by producing a concrete counterexample | Proposes a test or input; the host runs it as a deterministic check, and only a reproduced failure counts [Decision 0005] |
| Reviewer | Independently assesses each criterion | Reads the candidate and evidence; cannot edit its way to a pass |
| Integrator | Resolves how patches interact when reasoning is needed | The host applies candidates one at a time and runs the final checks |

Roles are profiles, not permanent agents. A task may coordinate its own sub-plan within the
same explicit delegation grant. Mechanical joining, checking, accounting and scheduling do not
need model calls, and a plan with a single task is valid for a small job. [§6]

Retrying the transport, repairing a malformed response, repairing a wrong result (*semantic
repair*), investigating, continuing and re-planning stay separate policies, each with its own
counter. Every loop records what failed, the proposed change or hypothesis, the observation it
expects, and the remaining allowance. A loop that keeps producing the same outcome stops.
Counters must not reset when context is compacted, a child is created, the system restarts or
an unrelated sibling succeeds; adapting after a failed child itself counts against the root's
semantic-repair allowance. [§6]

A semantic repair is a new attempt of the task that produced the wrong result, never a node
downstream of it, so the plan stays free of cycles. The new attempt receives the receipts that
rejected the previous one. [Decision 0005]

## 7. Budget and the lifecycle of a model request

There is one root budget whose total never grows (*conserved*). Budgets given to children are
earmarks or ceilings inside it, not new money or tokens. A request made inside a child is
reserved from that child's earmark; it must not be charged twice, once as the child's full
reserve and again as a separate root reservation. Changes to reservations are saved in the same
transaction as the admission they belong to, and at all times:

`spent + outstanding reservations <= authorized limit`

Only unused reservations are returned; usage that has been settled, failed attempts and tasks
admitted over the run's lifetime are not refunded. Capacity is reserved in advance for the
required checking, review and merging. [§7]

Before every request to a model provider, the harness checks the size of the actual request as
it will be sent, the exact route, the cap on output, the request count, the deadline,
cancellation and the budget available. Retries inside the SDK that are not accounted for are
switched off. The pinned Pi SDK needs a supported hook for this check, and that hook must be
proven to run before anything is sent; if that point cannot be enforced, the affected
capability is blocked rather than assumed to be under control. [§7]

A reservation moves through these states:

```text
reserved -> released_not_dispatched     proven no transport dispatch
reserved -> dispatch_intent             persisted before transport can begin
dispatch_intent -> settled              qualified outcome/usage receipt
dispatch_intent -> uncertain            outcome or usage cannot be established
uncertain -> reconciled                 explicit validated resolution
```

In words: a reservation is either released because it provably was never sent, or an
*intent to send* is saved before sending can begin. After that it is either settled by a
trustworthy receipt of outcome and usage, or marked uncertain if that cannot be established,
and an uncertain one is later reconciled by an explicit, validated decision. [§7]

Only an owner that holds the current *fencing token* and can prove that sending was not
possible may release a reservation. If the system crashed in `reserved`, before
`dispatch_intent`, recovery must first cancel or settle the previous owner, confirm that its
process can no longer send, and verify, under the qualified request protocol, that no intent to
send was saved; only then may it release the reservation, exactly once. If protocol
compatibility or the history of sends cannot be established, explicit reconciliation is
required instead of a guess. This crash case is tested separately from a live cancellation:
after a crash, the absence of a completion receipt does not prove that nothing was sent. A
crash after the intent was saved but before the network request can legitimately stay
uncertain. Cancellation, an expired deadline or a failure to save the request record before the
intent must release the reservation once and leave the run usable. This is a mandatory
regression test for a confirmed defect in the predecessor. [§7]

Unknown usage is not zero. Raw, bounded observations and how trustworthy they are are saved
separately from accounting estimates; credentials and unnecessary provider payloads are not
kept. A hard cap in money needs usable pricing and reservation rules for the route. A mode
limited by request count can work without exact cost reporting, but it must label the cost as
unknown and still enforce its other limits. Switching limits off or raising them requires an
operator amendment; model output cannot do it. [§7]

Reservations must cover the largest possible request and output usage of the supported route.
If observed usage exceeds that anyway, the system records the actual overspend and stops
admitting new requests until it is reconciled; it must never cap usage on paper or invent a
balanced budget. A local limit does not guarantee how a provider bills, so any claim of a hard
cap is qualified by which dimensions are enforced and what the supported route's reservation
guarantees. [§7]

## 8. Storage: SQLite, artifacts and migrations

Work package AP-04 makes a bounded decision between using SQLite directly and using durable
storage that Pi may provide, judged on transactions, migrations, fencing, backups, runtime
behaviour and failure testing. The interface the application uses stays the same whatever is
chosen, and this must not grow into a general database framework. No backend counts as chosen
merely because earlier discussions mentioned it. [§8]

Target tables or collections: runs and amendments; plan instances and revisions; task
revisions; attempts and segments; journal events; artifacts and references to them; check,
review and acceptance receipts; budgets, reservations and usage; records of spawning,
suspension and delivery; worker leases; actions on the outside world; questions and answers,
and operator commands. Rules that must be saved together are stored together. [§8]

Required constraints: unique identities within their scope, artifacts and revisions that
cannot change, repeat-safe command keys, compare-and-swap on the current revision (save only if
it is still the version the change was based on), ordered events, and fencing checks. Lookup of
task requests, views of ready and waiting work, plan ownership, unresolved actions and budget
summaries are indexed. Admitting work does not scan every run or usage record ever kept. [§8]

The design uses local SQLite in *WAL mode* (a journaling mode that lets reads continue while
writing) with an explicit policy for durability and backups, preferring that acknowledged
control changes are durably saved and documenting any weaker setting. No transaction stays
open while calling a provider, running a command or waiting for a child: the intent is saved,
the action is performed, and the outcome is settled in a new short transaction. The design
never claims that a change is atomic across the database and the file system together. [§8]

Artifacts are written to a temporary file, hashed, flushed to disk and moved into place in one
step, and only then is the reference saved. Hash and size are checked when the file is read. An
interrupted write may leave an unreferenced file to be cleaned up later, but never a valid
receipt pointing at missing bytes. Active attempts, child deliveries and unresolved actions are
protected from retention and garbage collection. Backups cover the database and all referenced
files together, and restoring is tested; copying an open database file on its own is not a
backup procedure. Migrations are applied in order, inside transactions where supported, and
bound to checksums. [§8]

## 9. Workspaces and running commands

The capture of the starting state is reproducible and includes the operator's staged,
unstaged and untracked work, without resetting or stashing it and without overwriting it. File
modes, deletions, symbolic links and relevant exclusions are preserved. A workspace's identity
includes the base revision plus the content, not just a commit ID. Secret files, and untracked
files that Git ignores, must not end up silently in task packets or artifacts; exclusions are
recorded explicitly. If required inputs cannot be captured under the current policy, this is
resolved before planning, rather than treating an incomplete snapshot as complete. [§9]

The design uses one workspace for merging the run's results and separate workspaces for tasks.
One writer holds each workspace's lease, and every writer running at the same time gets its own
*worktree* (a separate Git working copy). Readers running in parallel use unchangeable
snapshots or validated sets of files they read, never a tree someone else is editing. Sharing a
parent's workspace with a child needs an explicit handover of the lease; otherwise the child
starts from an identified snapshot of the parent. [§9]

Workers return proposed changes against a fingerprint of their base. The host applies them one
at a time to the merge workspace, records conflicts and how they were resolved, and reruns the
required checks on the combined code: patches that pass individually are not accepted
collectively. Delivery is a branch or patch plus an evidence report; changing the user's own
checkout is a separate, authorised step that first checks for drift. Finishing a plan must not
by itself trigger automatic commits, pushes, publication or deployment. [§9]

Tools that change files are bound to the file content they expect to find, so edits based on
stale content fail. The intent of each action and the resulting state or receipt are recorded.
Recovery checks the current bytes before deciding whether an edit happened. Replaying an
arbitrary command needs idempotency or reconciliation specific to that action. Checks are bound
to the identity of the executable, its arguments, the profile, the environment and the inputs,
plus a timeout and an observable exit status; test counts read from a tool's output are kept
distinct from reports based only on the exit code. [§9]

At first, commands are only available through configured profiles with arguments given as a
list. Checks that are already authorised do not ask for permission on every call; new
authority or an irreversible action follows the operator's configured rules. An unrestricted
shell, if explicitly switched on, has the full authority of the host: path patterns cannot
confine it, and neither a worktree nor `shell: false` is an operating-system sandbox. Version 1
supports trusted local repository processes and says so; isolating hostile workloads is
separate work. [§9]

## 10. Worker processes, the supervisor and recovery

One *supervisor* process starts on demand for a given repository and data store. It may keep
running when the Pi interface disconnects and exits according to an idle policy; it is not a
login service, not a fleet-wide background service and not a second scheduler. The `cli`
package owns wiring and local communication between processes (*IPC*); the engine owns
behaviour. IPC uses a protected local socket or named pipe, with size-limited, versioned
messages and checks that the caller is the same user. Every command and event is bound to the
repository, run and protocol identities. Messages from a model are never accepted as operator
answers, budget changes or approvals. [§10]

Worker messages carry the attempt and segment, the lease and fencing token, a sequence number
and a payload version. Results that arrive out of order, are too large, are stale or come from
the wrong owner are rejected. Workers ask a *broker* for host-owned tools; they never get
database access. What workers inherit from the environment is restricted, and provider
credentials stay out of artifact logs and repository commands. Separate processes are there to
control lifecycles, not to isolate, unless a real sandbox also enforces resource
restrictions. [§10]

A heartbeat shows that a worker is alive, not that it is in charge. When a lease is lost, the
broker's grant is revoked and the worker's process group is terminated before a replacement
writer is assigned. Fencing blocks stale saves but cannot undo a command that is already
running outside the broker's control; that action stays uncertain until settled. A workspace
that can be changed is never reassigned just because a timestamp expired. [§10]

On startup, recovery checks that the database format and runtime are compatible, takes back
ownership, replays saved decisions into the rebuilt views, reconciles records of workers,
processes and actions, and only then starts new work. Work that depends on an unknown outside
outcome is blocked with a typed explanation. Cancellation reaches every descendant that was
admitted or merely requested; the root is not settled while a child is reserved but not yet
planned, or while a command is unresolved. Reopening a run does not reset its limits. [§10]

## 11. Nested plans and plan revisions

Starting a child plan follows these steps [§11]:

1. Check the request against the parent's current revision, its frozen ceiling on delegation,
   the root's limits, the remaining depth, the inputs and the outputs the child must produce.
2. In one step, reserve the child's identity and capacity and save the intent to spawn it;
   repeating the same request key replays the same decision.
3. Finish and save the parent's current exchange with the model, record that the parent is
   suspended, and release its execution and writer slots before any descendant is scheduled.
4. Plan and admit the child under the same root budget. Planning the child may itself ask the
   operator a question, tied to the full position in the plan hierarchy and generation.
5. Run and verify the child locally. Check or review failures at the child's boundary get a
   typed way to recover, not a generic catch-all `blocked` result.
6. Save the child's outcome so it cannot change, deliver it and use it exactly once, and resume
   the parent as a fresh, accounted segment with refreshed sources, permissions and supported
   history. The parent's earlier edits are never replayed.
7. A child task can follow the same steps at depth 2. Grandchild tasks cannot ask for further
   plans.

Child repair, parent adaptation, clarification at the boundary, and cancellation must work for
every supported generation before recursive mode counts as complete. A typed child failure can
reach its parent only once the child's actions and descendants have settled and the root policy
allows adaptation. A policy refusal, an exhausted root budget and unknown outside outcomes are
never relabelled as repairable. [§11]

Plan revisions use compare-and-swap on the expected revision. Contracts and receipts that were
already executed stay as history. Changed task or input contracts invalidate the evidence
downstream; changed writers that were already applied require adapting from the current state.
Removing a task refunds nothing from the lifetime count of admitted tasks. Public child output
contracts, ownership and bindings to accepted results cannot change silently. At first,
revisions that would change ownership while descendants are active are rejected, rather than
inventing a complex way to migrate the structure. Accepted siblings that are unaffected stay
reusable only if their inputs are still valid. [§11]

## 12. Context and the operator's experience

The minimal context a worker is shown contains the objective, the requirements that cannot
change, the instructions that apply, the frozen permissions, the relevant slices of source and
artifacts, the decisions made, and the acceptance contract. Content from sources or tools is
labelled as data; it cannot change anyone's authority. The scopes of the root, of siblings and
of the operator's answers stay separate. References are saved for any reduction claimed to be
reversible; logging the name of something omitted does not preserve its content. If the
mandatory content does not fit, the attempt is narrowed or blocked. [§12]

One component is chosen to own compaction. The design starts with packets bounded by the host
and complete tool exchanges, then adds tested reductions and portable continuation later. The
exact route, prompt and tool identities are kept for compatibility; staying in a provider's
cache, or saving money, is never assumed just because prompts are stable. [§12]

Planned Pi commands: `/graph on`, `/graph off`, `/graph status`, `/graph pause`,
`/graph resume`, `/graph cancel` and `/graph inspect`, with equivalents in the command-line
tool and explicit run IDs where needed. Switching the mode off changes where future input goes;
it does not cancel active work. Restoring a session reads the saved status instead of
resubmitting the task. Only operator input is routed into a run, drafts typed while it is busy
are kept, and answers are tied to the saved open question. The interface shows why a task is
waiting, retrying or stopped. [§12]

Setup treats the commands it discovers as plain repository data that it does not run, resolves
the current, exact model route, and shows the effective policy for workspaces, checks and
budget. Existing mandatory checks are kept. Authorised configuration is reused without
repeating setup dialogs. Text-based controls come first; a graph editor or web dashboard is
deferred. [§12]

## 13. Order of work

The [implementation ledger](implementation-ledger.json) is the canonical map of which work
depends on which. AP-00 records only the verified scaffold; AP-01 to AP-25 describe
unimplemented work, and no future capability is marked done. [§13] *(The roadmap lists AP-01,
AP-26 and AP-27 as in progress; "in progress" means started, not implemented. See the
[roadmap](roadmap.md).)*

Work starts with **AP-01: versioned identities and state and result contracts**, whose first
increment needs no worker, database driver or model call. AP-02, AP-03 and AP-04 can then
progress independently against the agreed contracts, integrating before shared formats change.
[§13]

The early live evaluation (AP-16) is a separate gate. It does not block offline engineering
when credentials or authorisation are missing; that missing prerequisite is recorded
truthfully, rather than making up for it with a broad campaign. This document on its own
authorises no live run. [§13]

## 14. When is it done?

Each work package in the ledger carries an implementation status and evidence records; the
live evaluation is tracked separately. [§14]

- A **local, implementation-ready release** means AP-01 to AP-15 and AP-17 to AP-23 are
  implemented with their relevant local checks, and AP-25 evidence (installation and platform)
  passes for each platform claimed. Every scenario in the
  [acceptance matrix](acceptance-matrix.md), except the live AT-40, must be fully verified for
  that claimed scope.
- **Full qualification of the recursive product** additionally needs AT-40, AP-24 and its
  AP-16 live baseline, run under a frozen evaluation plan the operator approved. A local release
  that passes everything can be labelled local and experimental while its effectiveness on real
  tasks remains unproven; that distinction is not hidden. [§14]

The final demonstration must: create a task graph; spawn a child and a grandchild; suspend
parents without deadlock; survive a controlled kill and restart of the supervisor; settle or
explain interrupted actions; deliver descendants' results exactly once; adapt to a repairable
failure at a child's boundary; merge a candidate; and verify the final code, with budgets and
permissions bounded throughout. [§14]

The routine checks are `npm run check` and `npm run demo` until new commands exist. Commands
for focused, fault and live tests are added and documented by the work packages that own them.
[§14]

## Limitations

- Almost everything here is a target, not a feature. What exists today is plan checking, the
  flat reducer and the Pi session adapter [Architecture: What runs today].
- The numbers in §6 (4 sessions, 24 tasks, 2 repair rounds, 2 re-plans) are suggested
  defaults, not tested or enforced values.
- The storage backend is not chosen; §8 describes SQLite as the design's assumption, subject
  to the AP-04 decision.
- Hard budget caps are only as strong as the enforced dimensions and the provider route's
  guarantees; a local limit does not control how a provider bills (§7).
- Version 1 is not a security sandbox and supports trusted repositories only (§9).
- Whether graph mode is more effective than a single Pi session is unmeasured until AP-16 and
  AP-24 (§14).
- §14's release conditions do not mention AP-26 and AP-27, which the roadmap assigns to
  milestone M1; the sources do not say whether they are release conditions.

## Glossary

| Term | Meaning here |
| --- | --- |
| Acceptance gate | The host's step that decides, based on required receipts, whether a proposed result is accepted. |
| Amendment | A saved, explicit change to a run by the operator, such as new requirements. |
| Artifact | A stored file produced during a run, addressed by the hash of its content and never changed. |
| Baseline | The captured starting state of the repository, including uncommitted work. |
| Broker | The host component through which workers request tools and actions, instead of acting directly. |
| Child, grandchild | A sub-plan started by a task (depth 1), and one started from inside that (depth 2). Depth 2 cannot start further sub-plans. |
| Compare-and-swap | Saving a change only if the stored version is still the one the change was based on. |
| Conserved budget | A budget whose total never grows: children get portions of it, not additional money. |
| Contract | A data format with required content and guarantees. |
| DAG | Directed acyclic graph: a plan whose dependencies contain no circles. |
| Digest | A hash that identifies content exactly. |
| Durable | Saved so that it survives a crash or restart. |
| Falsifier | A role that tries to break a result by producing a counterexample the host can run as a check. |
| Effect | An action on the outside world: writing files, running commands, calling a model. |
| Fencing token | A number that increases with each new attempt; stale messages carrying a lower number are rejected. |
| Graph revision | A numbered, unchangeable version of a plan's content. |
| Host | The non-AI program that drives decisions, stores events and carries out actions. |
| Idempotency key | A request key that makes repeating the same request safe; different content under the same key is a conflict. |
| IPC | Inter-process communication: how the command-line tool, the Pi extension and the supervisor talk locally. |
| Journal | The append-only, ordered log of events for a run. |
| Lease | A time-limited claim that a worker owns a piece of work. |
| Migration | An ordered, versioned change to the database's structure. |
| pi-graph | The predecessor project whose lessons this design adopts. |
| Port | An interface in `core` describing an effect, implemented by another package. |
| Reconciliation | Explicitly deciding what really happened to an action whose outcome was unknown. |
| Reducer | The decision function `decide(state, event)`, which returns the new state and commands without side effects. |
| Reservation | Budget set aside before it is spent, so that concurrent requests cannot overspend. |
| Route | The exact provider, model and API used for a model request. |
| SDK | Software development kit: the library through which programs use Pi. |
| Semantic repair | Another attempt to fix a result that was wrong, as opposed to one that was merely malformed. |
| Supervisor | The local background process that will run the host for one repository. |
| Task graph | A plan: tasks and their dependencies. |
| Verifying node | A task that reads another task's result before it is accepted, in order to check it. The producer's acceptance waits for it. |
| WAL mode | Write-ahead logging, an SQLite mode that lets reads continue while writing. |
| Work package (AP-xx) | One numbered unit of planned work in the ledger. |
| Worktree | A separate Git working copy, used so parallel writers do not collide. It is not a security sandbox. |
