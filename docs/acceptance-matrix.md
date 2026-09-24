# Full-project acceptance matrix

Status: proposed target scenarios, 2026-09-22. This matrix translates the
[scaffold handoff](archive/scaffold-handoff.md), [architecture](archive/initial-architecture.md), and
[pi-graph review](reviews/pi-graph-2026-09-22.md) into observable acceptance
conditions for the full local auto-pi-lot product. It is a design and verification plan,
not a record of executed tests. No scenario below is verified yet; the
[implementation ledger](implementation-ledger.json) tracks each scenario's status.

The [design document](design.md) defines target semantics. The implementation ledger
also owns each scenario's implementation link and executed evidence receipts. Scenario
IDs are stable: a milestone can reorder work without renumbering a scenario. This matrix
has no checked boxes, because checking one here would conflate a proposed assertion with
its observed result.

A package can finish its own slice of a scenario before downstream packages exist. Its
receipt names the assertions it covers and what remains. A scenario counts as verified
only once every assertion and required evidence class is covered for its claimed
environments; one package finishing its part does not mark a shared scenario passed.

## Evidence classes and receipt contract

| Class | Evidence expected |
| --- | --- |
| Unit | Deterministic contract or state-machine test with fake inputs and no process effects. |
| Local integration | Fake reasoning against real temporary SQLite, artifacts, Git repositories, and controlled commands. |
| Process fault | Supervisor/worker termination or injected failure at a named boundary, followed by reopen and state inspection. |
| Offline SDK | Pinned Pi SDK with fake stream/provider and controlled resource loader; no provider traffic. |
| Live | Optional, explicitly bounded real provider task or route check with declared cost ceiling and corpus. |
| Platform | Actual Pi extension and supported OS/Node installation or packaging smoke test. |

Every executed receipt should record the scenario ID; source identity (commit plus
dirty-tree fingerprint when relevant); contract/schema and SQLite migration versions;
Node/npm/Pi versions; OS; command and arguments; environment or fixture identity;
injection point and seed; start and end time; exit/result; observed assertions; artifact
hashes or paths; and any skip or qualification with reason. Keep credentials and raw
private transcripts out of receipts. Live evidence also records the exact route, declared
allowance, observed usage, unknown usage fields, task corpus revision, and the
single-session comparison method. A mock or fake provider receipt cannot prove live
coding effectiveness, billing, isolation of a real provider, or platform behavior.

Fault injection means stopping before or after a durable commit or external-effect
boundary, then reopening the same run and checking both stored state and visible effects.
It is not enough to throw within one in-memory transaction and call that crash recovery.
When a command's or remote call's outcome is unknowable after a crash, the correct
assertion is a durable uncertain/reconciliation state, not exactly-once execution. Tests
should identify which side of a boundary the injected stop reached.

## Intake, protocol, planning, and root requirements

| ID | Trigger | Observable assertion | Evidence class |
| --- | --- | --- | --- |
| AT-01 | Submit a new coding task in graph mode. | A single durable root run exists before planning, binding request identity, objective, repository baseline, immutable requirements, and one root allowance. | Local integration |
| AT-02 | Repeat an intake request or reuse its key with different content. | An identical request returns the same run without fresh allowance or planning; conflicting content is rejected. Indexed lookup identifies the original run. | Local integration |
| AT-03 | Submit malformed or unsupported-version graph, spawn, or worker DTOs. | Boundary parsing rejects them with typed errors; no state or budget changes occur. Graph revision and wire schema version remain distinct. | Unit |
| AT-04 | Planner proposes omitted criteria, missing artifact producers, inaccessible inputs, unsupported roles/models/checks, or a cycle. | Host validation rejects the graph; root requirements, dependency reachability, and declared artifact bindings cannot be weakened by model output. | Unit |
| AT-05 | Planner proposes an agent node followed by a configured host check. | Check node is bound to an operator-approved profile, runs through host authority, and gates downstream acceptance without accepting the agent's claimed pass. | Local integration |
| AT-06 | Crash after plan admission but before publication, then reopen. | Previously admitted plan and its charge are reused exactly once; restart does not create a second run, plan revision, or planning allowance. | Process fault |
| AT-07 | Small task qualifies for one-node execution. | Planner may admit a single useful node; graph validation does not require artificial decomposition. | Unit |

## Results, checks, budgets, and request boundaries

| ID | Trigger | Observable assertion | Evidence class |
| --- | --- | --- | --- |
| AT-08 | Worker reports success, invalid output, or a passing command string. | Result remains a proposal/result-ready state; only supervisor authority with required typed receipts may mark it accepted. Invalid, failed, or cancelled output does not unlock dependents. | Local integration |
| AT-09 | Required verifier node has not passed, or its check receipt is stale. | The verifier can consume provisional output on a `result_ready` edge; consumers requiring `accepted` remain blocked. Host acceptance cites the required verifier receipt and exact input and result revisions. | Local integration |
| AT-10 | Inputs, code revision, check profile, or execution environment change after a pass. | Stale evidence is rejected or invalidated; a new check on the new identity is required before acceptance. | Local integration |
| AT-11 | Reserve allowance, then cancel, expire, fail manifest persistence, or crash before dispatch intent. | For live failure, release the proven-unused reservation once. After a crash, first fence/stop the old owner and prove no dispatch intent exists under the qualified protocol; recovery then releases once and later admission works. Without that proof, require reconciliation. This directly guards the legacy pi-graph defect. | Local integration, process fault, offline SDK |
| AT-12 | Stop after the dispatch boundary may have been crossed, without a definitive provider receipt. | Charge is marked uncertain and conservatively held for reconciliation; it cannot be relabeled as proven unused or silently retried. | Process fault, offline SDK |
| AT-13 | Concurrent child/spawn/model admissions target the remaining root allowance. | Atomic reservations cannot oversubscribe the account; planning, failed attempts, retries, checks, continuation, and descendants charge the same root. Exhaustion has a typed terminal outcome and leaves criteria intact. | Local integration |
| AT-14 | Implementer requests a configured check during an edit. | Host executes only an allowed profile, records a receipt, returns bounded feedback, and charges the existing run; the final independent check remains required. | Local integration |
| AT-15 | Repair repeats the same failure or exceeds its limit. | New attempts identify hypothesis, expected observation, and changed evidence; no-progress or exhausted loops stop with preserved artifacts and typed outcome. | Unit, local integration |

## Durable state, artifacts, processes, and effects

| ID | Trigger | Observable assertion | Evidence class |
| --- | --- | --- | --- |
| AT-16 | Commit a state transition with its journal event, then reopen SQLite. | State and append-only event agree; injection on either side of commit produces either the old or the new complete transition, never a torn pair. | Process fault |
| AT-17 | Write and link an artifact across crash boundaries. | Content hash verifies bytes, committed links remain resolvable, and orphan or incomplete blobs are detected/reconciled without fabricating evidence. | Process fault |
| AT-18 | Reopen a run with pending worker, command, or model effects. | Supervisor reconciles leases and intent/receipt records before replacement dispatch; ambiguous external effects remain explicit. | Process fault |
| AT-19 | Old worker reports after lease expiry and a replacement acquires a higher fencing token. | Stale result, artifact acceptance, and account settlement are rejected without changing the current attempt. | Local integration, process fault |
| AT-20 | Crash around a workspace edit or controlled command. | Durable intent and observed effect/receipt identify whether to reuse, inspect, or reconcile; applied edits are not blindly replayed. | Process fault |
| AT-21 | Cancel an active run, including children and processes. | Descendant cancellation propagates, processes stop or reach a documented terminal state, no new work dispatches, and partial artifacts and charges remain inspectable. | Process fault |
| AT-22 | Apply an ordered migration or open a database with an unexpected checksum/version. | Supported migration completes reproducibly; mismatch fails closed with source state preserved and a recovery path documented. | Local integration, process fault |

## Workspace and integrated coding result

| ID | Trigger | Observable assertion | Evidence class |
| --- | --- | --- | --- |
| AT-23 | Start with tracked and untracked user edits in the checkout. | Reproducible baseline captures them; worker and integration steps neither discard nor silently overwrite those changes. | Local integration |
| AT-24 | Two writers run concurrently on assigned paths. | Separate worktrees and enforced scope keep writes isolated; unauthorized tool/file access is denied by the actual executor policy being claimed, not inferred from worktree placement. | Local integration |
| AT-25 | Two candidate patches pass individually but conflict or fail together. | Serial integration detects conflict, preserves candidates, and requires checks on the combined revision before root acceptance. | Local integration |
| AT-26 | Integration changes a child-verified revision. | Child receipt stays historical, final evidence is tied to the integrated tree, and root acceptance waits for that tree's checks and review. | Local integration |

## Pi sessions, routing, context, and operator input

| ID | Trigger | Observable assertion | Evidence class |
| --- | --- | --- | --- |
| AT-27 | Start a worker with ambient Pi extensions, default tools, or repository instructions present. | Resource loader exposes only frozen grants; ambient canary never loads; relevant instructions have explicit provenance and credentials stay outside model-visible packets. | Offline SDK |
| AT-28 | Select an allowed provider/model/API route or request fallback. | Exact route is frozen per attempt; unsupported route fails before dispatch; fallback occurs only under explicit policy and appears in receipt/accounting. | Offline SDK |
| AT-29 | SDK adds messages or tool material after application context assembly. | Host measures/adjudicates final serialized payload before dispatch and records admission result; hidden SDK retries cannot bypass the root account. | Offline SDK |
| AT-30 | Provider usage omits counters, exceeds its reservation, or provider call fails. | Unknown usage remains unknown, measured zero remains distinct, and settlement/reconciliation follows the dispatch state. An overrun records actual usage and stops new admission; it is never clamped to fabricate conservation. | Offline SDK |
| AT-31 | Worker context is reduced for a descendant or resumed attempt. | Mandatory criteria remain, facts and hypotheses keep provenance, omission manifest identifies removed material, and every claimed retrievable reduction points to an existing immutable artifact. | Local integration |
| AT-32 | Toggle graph mode, send input while busy, reload the Pi UI, then turn mode off. | Only intended operator input enters the run; busy draft stays visible; reload queries durable status without redispatch; off changes future routing and does not cancel the active run. | Platform |
| AT-33 | Worker needs clarification and operator answers, including a duplicate answer after restart. | Structured question and answer belong to the same run, preserve its allowance, resume the correct graph/node path, and consume duplicate delivery once. | Local integration, platform |
| AT-34 | Operator pauses, resumes, steers, or cancels a run. | Action is durably recorded; pause stops new dispatch, steering revises affected contracts/evidence, resume uses the same run, and cancel has distinct semantics from off. | Local integration, platform |

## Child graphs, revisions, recovery, and release qualification

| ID | Trigger | Observable assertion | Evidence class |
| --- | --- | --- | --- |
| AT-35 | Parent requests a child or child requests a grandchild. | Spawn is bound to owning node/run and explicit narrower model, check, tool, workspace, criteria, and budget ceilings; depth 2 cannot spawn further; duplicate key returns same child. | Unit, local integration |
| AT-36 | Every global worker slot is occupied by a parent awaiting a child. | Parents persist suspension and release permits/resources; ready descendants run under the one scheduler without starvation or cross-hierarchy wait cycle. | Local integration |
| AT-37 | Child completes across result-delivery crash points. | Durable typed result is consumed once by a fresh parent segment; parent edits, charges, and repair count are not replayed or reset. | Process fault |
| AT-38 | Child check/review fails, needs clarification, is denied, or exhausts allowance. | Failure has a typed disposition at the full graph/node path; repairable failure enters bounded repair, other cases return the appropriate terminal/question state, and successful siblings remain usable. | Local integration, process fault |
| AT-39 | Planner revises a graph after new evidence. | Compare-and-swap admits an immutable revision; stale patch loses, affected downstream results/evidence invalidate, and unaffected accepted work stays reusable. | Local integration |
| AT-40 | Run optional live coding qualification against a fixed corpus. | With an operator-approved task set, cost ceiling, route, and comparison method, receipts count accepted outcomes, failed/cancelled work, usage uncertainty, and latency against a single Pi session. No arbitrary pass threshold is implied by this matrix. | Live |
| AT-41 | Install and launch the supported package/extension on declared Node/OS targets. | Pinned dependency and package entry points load; CLI and Pi extension attach to the same local supervisor and report the run's durable identity/status. | Platform |

The implementation ledger should distinguish **unimplemented**, **implemented but
unverified**, **verified with receipt**, **failed**, **blocked**, and **deferred** for
each scenario. A scenario may have multiple receipts for different platforms or
injection points. A skip is recorded with its reason, never counted as a pass.
Live qualification needs a separate, operator-approved evaluation plan before
provider traffic; this matrix neither authorizes calls nor sets a success threshold.
