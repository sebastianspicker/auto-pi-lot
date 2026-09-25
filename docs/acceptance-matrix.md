# Full-project acceptance matrix

Status: proposed target scenarios, 2026-09-22.

**In short.** This page lists 41 situations, AT-01 to AT-41, that the finished auto-pi-lot
must be shown to handle correctly: mostly failures such as crashes, stale workers, budget
exhaustion and conflicting changes. For each one it says what triggers it, what must be
observed, and what kind of evidence counts. It is a plan for verification, not a test
report: **none of the 41 scenarios is verified yet**, and the
[implementation ledger](implementation-ledger.json) is where their status is tracked.
[Matrix: intro]

*About this page.* It is a plain-language edition of the acceptance matrix for engineers and
engineering leads who want to judge what "done" will mean for this project. Scenario IDs are
unchanged. Bracketed references such as [Matrix: Evidence classes] point to the section of
the original document this edition was rewritten from; the originals are in the Git history
at commit `bf04bd0`. Terms in *italics* on first use are defined in the
[glossary](#glossary). For the behaviour behind each scenario, see the
[design document](design.md).

## What this page is, and is not

- It turns earlier planning documents, the [scaffold handoff](archive/scaffold-handoff.md),
  the [initial architecture](archive/initial-architecture.md) and the
  [review of the predecessor project pi-graph](reviews/pi-graph-2026-09-22.md), into
  conditions that can be observed from outside. [Matrix: intro]
- The design document defines what the behaviour should be. The ledger records, for each
  scenario, its implementation link and the evidence from actual runs. Scenario IDs never
  change, even if milestones are reordered. [Matrix: intro]
- There are deliberately no checkboxes here: ticking one would mix up a proposed check with an
  observed result. [Matrix: intro]

**When does a scenario count as verified?** Parts of the system can finish their share of a
scenario before other parts exist, and record which checks they cover and what remains. A
scenario counts as verified only when every check and every required kind of evidence is
covered for every environment it claims. One package finishing its part does not mark a shared
scenario as passed. [Matrix: intro]

## Kinds of evidence

| Kind | What it means |
| --- | --- |
| Unit | A deterministic test of a data format or decision, with fake inputs and no real processes or files. |
| Local integration | Fake model reasoning, but real temporary SQLite databases, stored files, Git repositories and controlled commands. |
| Process fault | Deliberately killing or breaking the supervisor or a worker at a named point, then reopening the run and inspecting its state. |
| Offline SDK | The pinned Pi software development kit (SDK) with a fake model provider and controlled loading of resources; no traffic to a real provider. |
| Live | Optional, explicitly limited use of a real model provider, with a declared cost ceiling and a declared set of tasks. |
| Platform | Installing and starting the actual Pi extension on a supported operating system and Node.js version. |

[Matrix: Evidence classes]

### What every test record must contain

Every record of an executed test (a *receipt*) should state: the scenario ID; the exact
source version (commit, plus a fingerprint of uncommitted changes where relevant); the
versions of the data formats and database migrations; the Node.js, npm and Pi versions; the
operating system; the command and its arguments; the environment or test-fixture identity;
where a fault was injected and the random seed; start and end time; the exit status or result;
the checks actually observed; hashes or paths of stored files; and any skipped part with the
reason. Credentials and raw private conversation logs stay out of receipts. [Matrix: receipt
contract]

Live evidence also records the exact route to the model, the declared spending allowance, the
usage observed, which usage figures were unknown, the version of the task set, and how the
comparison with a single Pi session was made. A test with a mock or fake provider cannot prove
real coding effectiveness, billing, isolation of a real provider, or platform behaviour.
[Matrix: receipt contract]

### What "fault injection" means here

Fault injection means stopping the system just before or just after the point where a change
is saved for good, or where an action on the outside world happens, and then reopening the same
run and checking both the stored state and what visibly happened. Throwing an error inside a
single in-memory operation and calling that "crash recovery" is not enough. When the outcome
of a command or remote call cannot be known after a crash, the correct expectation is a saved
"uncertain, needs reconciliation" state, not a claim that it ran exactly once. Tests should
say which side of the boundary the injected stop reached. [Matrix: receipt contract]

## Scenarios

Each table gives the scenario ID, what triggers it, what must be observed, and the kind of
evidence required.

### Taking in a task, checking the plan, and the run's fixed requirements

| ID | Trigger | What must be observed | Evidence |
| --- | --- | --- | --- |
| AT-01 | A new coding task is submitted in graph mode. | Before any planning, exactly one saved root run exists that ties together the request's identity, the objective, the starting state of the repository, requirements that cannot be changed later, and one budget for the whole run. | Local integration |
| AT-02 | The same request is submitted again, or its request key is reused with different content. | An identical request returns the same run, with no new budget and no new planning. Different content under the same key is rejected. The original run can be found through an index. | Local integration |
| AT-03 | A plan, a request to start a sub-plan, or a worker message arrives malformed or in an unsupported version. | It is rejected at the boundary with a typed error; no state or budget changes. A plan's revision number and the data format's version number stay separate. | Unit |
| AT-04 | The planning model proposes a plan with missing acceptance criteria, inputs nobody produces, inaccessible inputs, unsupported roles, models or checks, or a circular dependency. | The host's plan checking rejects it. Model output cannot weaken the run's requirements, whether dependencies are reachable, or the declared links between files and the tasks that produce them. | Unit |
| AT-05 | The planning model proposes an AI task followed by a configured check run by the host. | The check is bound to a check profile the operator approved, runs under the host's authority, and gates acceptance of what follows. The AI task's own claim that it passed is not accepted. | Local integration |
| AT-06 | The system crashes after a plan was admitted but before it was published, and is reopened. | The admitted plan and its cost are reused exactly once. The restart creates no second run, plan revision or planning budget. | Process fault |
| AT-07 | A small task only needs one step. | The planner may admit a single useful task; plan checking does not force an artificial split. | Unit |

[Matrix: Intake, protocol, planning, and root requirements]

### Results, checks, budgets and model requests

| ID | Trigger | What must be observed | Evidence |
| --- | --- | --- | --- |
| AT-08 | A worker reports success, returns invalid output, or reports a check command as passing. | The result stays a proposal ("result ready"). Only the supervisor's authority, backed by the required typed receipts, can mark it accepted. Invalid, failed or cancelled output does not unblock the tasks that depend on it. | Local integration |
| AT-09 | A required verifier task has not passed, or its check receipt is out of date. | The verifier may work on the unaccepted result through a "needs a result" (`result_ready`) link, while tasks that need an accepted result stay blocked. The host's acceptance cites the required verifier receipt and the exact input and result versions. | Local integration |
| AT-10 | The inputs, code version, check profile or execution environment change after a check passed. | The old evidence is rejected or marked invalid; a new check on the new version is required before acceptance. | Local integration |
| AT-11 | Budget is reserved, and then the work is cancelled, times out, fails to save its request record, or crashes before the intent to send a request was saved. | In a live failure, the reservation that was provably never used is released exactly once. After a crash, the system first stops or *fences* the old owner and proves, under the qualified request protocol, that no send intent exists; only then does recovery release the reservation once, and later requests are admitted normally. Without that proof, reconciliation is required. This scenario guards directly against a known defect in the predecessor project, pi-graph. | Local integration, process fault, offline SDK |
| AT-12 | The system stops after a request may already have been sent, without a definitive receipt from the provider. | The charge is marked uncertain and held back, to be on the safe side, until reconciled. It cannot be relabelled as provably unused, and it is not silently retried. | Process fault, offline SDK |
| AT-13 | Several sub-plans, child tasks or model requests compete for the remaining root budget at the same time. | Reservations are all-or-nothing and cannot overspend the budget. Planning, failed attempts, retries, checks, continuations and descendants all charge the same root budget. Running out ends the run with a typed outcome and leaves the acceptance criteria intact. | Local integration |
| AT-14 | An implementer asks for a configured check while editing. | The host runs only an allowed check profile, records a receipt, returns limited feedback and charges the existing run. The final independent check is still required. | Local integration |
| AT-15 | A repair attempt repeats the same failure, or exceeds its limit. | Each new attempt states its hypothesis, the observation it expects and what evidence changed. Loops that make no progress, or run out, stop with their files kept and a typed outcome. | Unit, local integration |

[Matrix: Results, checks, budgets, and request boundaries]

### Saved state, stored files, processes and actions on the outside world

| ID | Trigger | What must be observed | Evidence |
| --- | --- | --- | --- |
| AT-16 | A state change is saved together with its journal event, and the SQLite database is reopened. | State and the append-only event log agree. A fault on either side of the save produces either the complete old or the complete new change, never half of one. | Process fault |
| AT-17 | A stored file is written and linked to a run across crash points. | The content hash matches the bytes; saved links still resolve; orphaned or incomplete files are detected and reconciled without inventing evidence. | Process fault |
| AT-18 | A run is reopened while worker, command or model actions are still pending. | The supervisor reconciles *leases* and its records of intended and completed actions before starting any replacement. Actions whose outcome is unclear stay explicitly marked as such. | Process fault |
| AT-19 | An old worker reports back after its lease expired, and a replacement already holds a higher *fencing token*. | The stale result, the acceptance of its files and the settlement of its costs are all rejected, and the current attempt is unaffected. | Local integration, process fault |
| AT-20 | The system crashes around a workspace edit or a controlled command. | The saved intent and the observed effect or receipt show whether to reuse, inspect or reconcile. Edits that were already applied are not blindly repeated. | Process fault |
| AT-21 | An active run is cancelled, including its sub-plans and processes. | Cancellation reaches every descendant; processes stop or reach a documented final state; no new work starts; partial files and charges stay available for inspection. | Process fault |
| AT-22 | A database migration is applied in order, or a database with an unexpected checksum or version is opened. | A supported migration completes the same way every time. A mismatch stops the system safely, keeps the existing data, and has a documented recovery path. | Local integration, process fault |

[Matrix: Durable state, artifacts, processes, and effects]

### Workspaces and the combined coding result

| ID | Trigger | What must be observed | Evidence |
| --- | --- | --- | --- |
| AT-23 | The user's checkout already contains uncommitted edits, tracked and untracked. | A reproducible snapshot captures them; workers and the merge step neither discard nor silently overwrite them. | Local integration |
| AT-24 | Two tasks that write files run at the same time on their assigned paths. | Separate *worktrees* and enforced scopes keep their writes apart. Access to tools or files outside the permitted scope is denied by the actual enforcement mechanism being claimed, not merely assumed from where the worktree is. | Local integration |
| AT-25 | Two proposed patches each pass on their own but conflict, or fail when combined. | Merging them one at a time detects the conflict, keeps both candidates, and requires checks on the combined version before the run's result is accepted. | Local integration |
| AT-26 | Merging changes a version that a sub-plan had already verified. | The sub-plan's receipt stays as history; the final evidence is tied to the merged code, and the run's acceptance waits for checks and review of that merged code. | Local integration |

[Matrix: Workspace and integrated coding result]

### Pi sessions, model routes, context and operator input

| ID | Trigger | What must be observed | Evidence |
| --- | --- | --- | --- |
| AT-27 | A worker starts while other Pi extensions, default tools or repository instructions are present. | Only the permissions frozen for that worker are loaded; a planted test extension (a *canary*) never loads; relevant instructions carry an explicit record of where they came from; credentials stay out of anything the model can see. | Offline SDK |
| AT-28 | An allowed provider, model and API *route* is selected, or a fallback is requested. | The exact route is fixed for each attempt. An unsupported route fails before anything is sent. Fallback happens only under an explicit policy and appears in the receipt and the accounting. | Offline SDK |
| AT-29 | The Pi SDK adds messages or tool material after the application has assembled the request. | The host measures and approves the final request as actually sent, and records the decision. Retries hidden inside the SDK cannot get around the root budget. | Offline SDK |
| AT-30 | The provider's usage report is missing figures, exceeds the reservation, or the call fails. | Unknown usage stays unknown and is kept distinct from a measured zero. Settlement or reconciliation follows from how far the request got. An overspend records the actual usage and stops new requests; it is never capped on paper to make the budget appear to balance. | Offline SDK |
| AT-31 | A worker's context is shortened for a sub-task or a resumed attempt. | Mandatory criteria stay in; facts and hypotheses keep their source; a list records what was removed; and every reduction claimed to be reversible points to an existing, unchangeable stored file. | Local integration |
| AT-32 | The operator switches graph mode on, types while it is busy, reloads the Pi interface, then switches it off. | Only intended operator input enters the run; the unsent draft stays visible; reloading reads the saved status without starting work again; switching off changes where future input goes and does not cancel the running work. | Platform |
| AT-33 | A worker needs clarification and the operator answers, including a duplicate answer after a restart. | The question and answer belong to the same run, keep its budget, resume the correct plan and task, and a duplicate answer is used only once. | Local integration, platform |
| AT-34 | The operator pauses, resumes, redirects (*steers*) or cancels a run. | The action is saved. Pause stops new work from starting; steering revises the affected requirements and evidence; resume continues the same run; cancel means something different from switching graph mode off. | Local integration, platform |

[Matrix: Pi sessions, routing, context, and operator input]

### Sub-plans, plan revisions, recovery and release qualification

| ID | Trigger | What must be observed | Evidence |
| --- | --- | --- | --- |
| AT-35 | A task asks to start a sub-plan (*child*), or a child task asks to start one of its own (*grandchild*). | The request is tied to the task and run that own it, and to explicitly narrower limits on models, checks, tools, workspace, criteria and budget. A task at depth 2 cannot start further sub-plans. Repeating the same request key returns the same child. | Unit, local integration |
| AT-36 | Every global worker slot is taken by a parent that is waiting for its child. | Parents save their paused state and give up their slots and resources; ready descendants run under the one scheduler without being starved, and no chain of waiting across levels blocks everything. | Local integration |
| AT-37 | A child finishes while the delivery of its result is interrupted by crashes. | A saved, typed result is used exactly once by a fresh continuation of the parent. The parent's edits, charges and repair count are neither repeated nor reset. | Process fault |
| AT-38 | A child's check or review fails, it needs clarification, it is refused, or it runs out of budget. | The failure has a typed outcome at its full position in the plan hierarchy. A repairable failure enters a bounded repair; other cases end in the appropriate final or question state; siblings that succeeded remain usable. | Local integration, process fault |
| AT-39 | The planner revises a plan after new evidence. | An all-or-nothing compare-and-swap admits a new, unchangeable revision; a patch based on an out-of-date revision loses; results and evidence downstream of the change become invalid; unaffected accepted work stays reusable. | Local integration |
| AT-40 | The optional live coding evaluation is run on a fixed set of tasks. | With an operator-approved task set, cost ceiling, model route and comparison method, receipts count accepted outcomes, failed or cancelled work, uncertain usage and time taken, compared against a single Pi session. This page does not set a pass mark. | Live |
| AT-41 | The supported package and extension are installed and started on the declared Node.js and operating-system targets. | Pinned dependencies and package entry points load; the command-line tool and the Pi extension connect to the same local supervisor and report the run's saved identity and status. | Platform |

[Matrix: Child graphs, revisions, recovery, and release qualification]

## How status is recorded

For each scenario, the ledger should distinguish **unimplemented**, **implemented but
unverified**, **verified with receipt**, **failed**, **blocked** and **deferred**. A scenario
can have several receipts, for different platforms or fault points. A skipped test is
recorded with its reason and never counted as a pass. [Matrix: closing paragraph]

The live evaluation needs its own operator-approved evaluation plan before any traffic to a
model provider. This page neither authorises model calls nor sets a success threshold.
[Matrix: closing paragraph]

## Limitations

- These are proposed checks, dated 2026-09-22. None has been run as a verification of the
  finished system; the ledger currently records all 41 as unimplemented. [Matrix: intro;
  ledger]
- Live effectiveness (AT-40) has no pass mark defined here; whether graph mode beats a single
  Pi session is an open question until that evaluation is designed and run. [Matrix: AT-40]
- Several scenarios depend on design decisions not yet made, such as the storage backend
  (work package AP-04). [Design §8]

## Glossary

| Term | Meaning here |
| --- | --- |
| Canary | A deliberately planted item, here a test extension, whose appearance would prove that something leaked in. |
| Child, grandchild | A sub-plan started by a task (depth 1), and a sub-plan started from inside that (depth 2). Depth 2 cannot start further sub-plans. |
| Compare-and-swap | Saving a change only if the stored version is still the one the change was based on; otherwise the change loses. |
| Fencing token, fence | A number that increases with each new attempt; stale messages with a lower number are rejected. To fence an old owner is to make sure it can no longer act. |
| Journal | The append-only log of events for a run. |
| Lease | A time-limited claim that a worker owns a piece of work. |
| Receipt | A saved record of an executed check or test, with the details needed to trust and reproduce it. |
| Reconciliation | Deciding explicitly what really happened to an action whose outcome was unknown, instead of guessing. |
| Reservation | Budget set aside before it is spent, so concurrent requests cannot overspend. |
| Route | The exact combination of provider, model and API used for a model request. |
| SDK | Software development kit: the library through which programs use Pi. |
| Steering | The operator changing a running task's direction, recorded as an explicit amendment. |
| Worktree | A separate Git working copy, so parallel writers do not edit the same files. It is not a security sandbox. |
