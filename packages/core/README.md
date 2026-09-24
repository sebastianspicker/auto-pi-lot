# @auto-pi-lot/core

The deterministic, provider-neutral domain: wire schemas and canonical identity, graph spec
and validation, run state vocabulary, journal events, the pure run reducer and replay,
evidence records, and the session port. Imports only `zod` and `node:crypto` — no workspace
dependency, no provider SDK, no I/O. See [docs/architecture.md](../../docs/architecture.md)
for how this package fits the rest of the workspace and how that boundary is enforced.

## Modules

`src/index.ts` re-exports every module below. Import from the package root
(`@auto-pi-lot/core`) for the domain, or from `@auto-pi-lot/core/session` for the session port
alone; `packages/pi` may use only the latter.

| Module | Owns |
| --- | --- |
| `wire.ts` | `SCHEMA_VERSION`/`SchemaVersionSchema`, `IdSchema`/`Id`, `IssueCode`, `ValidationIssue`, `parseDto` |
| `canonical.ts` | `canonicalJson`/`digest`: one canonical JSON encoding and its SHA-256 identity |
| `graph/spec.ts` | `Role`, `NodeLimits`, `NodeSpec`, `DependencyCondition`, `EdgeSpec`, `GraphSpec` |
| `graph/validate.ts` | `ValidatedGraph`, `validateGraph`, `topologicalOrder`, `parseGraphSpec` |
| `run/status.ts` | `ExecutionState`, `ResultDisposition`, `FailureCategory`, `NodeStatus`, `isDependencySatisfied` |
| `run/evidence.ts` | `ResultProposal`, `CheckReceipt`, `ReviewReceipt`, `AcceptanceRecord` |
| `run/events.ts` | `JournalEvent` discriminated union, `RunPolicy`, `parseJournalEvent` |
| `run/state.ts` | `RunState`, `NodeRunState`, `AttemptState`, `initialState`, `freshNodeState`, `isTerminalStatus` |
| `run/commands.ts` | `Command` (`dispatch`, `evaluate_acceptance`, `cancel_attempt`, `complete_run`) |
| `run/readiness.ts` | `getReadyNodes` |
| `run/decide.ts` | `decide`: the pure run reducer |
| `run/replay.ts` | `replay` |
| `session.ts` | `SessionEvent`, `CodingSession` (also the `./session` subpath) |

## Wire identity

Every persisted or exchanged DTO carries a `schemaVersion` literal (currently `1`), distinct
from a graph's `revision` (plan content history). `canonicalJson` sorts object keys, keeps
array order, normalizes `-0` to `0`, and throws on `undefined` property values, non-finite
numbers, `bigint`, functions, symbols, sparse arrays, and non-plain objects (`Date`, `Map`,
class instances) rather than silently guessing an encoding. `digest` hashes the canonical
form with SHA-256, prefixed `sha256:`. Test vectors live in
`test/vectors/canonical.json` and are checked in `test/canonical.test.ts`.

## Execution versus acceptance

`ExecutionState` (`pending`, `ready`, `running`, `waiting_children`, `waiting_input`,
`waiting_approval`, `result_ready`, `failed`, `cancelled`, `exhausted`) tracks a node's own
progress. `ResultDisposition` (`unverified`, `verifying`, `accepted`, `rejected`,
`invalidated`) tracks host trust in a produced result. They are independent dimensions,
combined in a `NodeStatus`.

A `DependencyCondition` on each edge (`result_ready` or `accepted`, required, no default)
states what a consumer needs from its producer. `isDependencySatisfied` is the single pure
rule: `accepted` requires `disposition === "accepted"`; `result_ready` requires
`execution === "result_ready"` and `disposition` in `{unverified, verifying, accepted}`.
A verifier can consume a `result_ready` edge from an unverified implementer; a consumer that
needs trusted output must wait on an `accepted` edge. Rejected, invalidated, or failed
producers never satisfy either condition. `getReadyNodes` (`run/readiness.ts`) applies this
rule over a `ValidatedGraph` and a map of `NodeStatus` to compute the topologically ordered
set of nodes ready to dispatch; it does not dispatch work or allocate permits itself.

## Proposal versus acceptance record

`ResultProposal` is a worker's own claim: summary, output artifact IDs, claims, limitations,
requested checks, and an input fingerprint. It has no `status`/`accepted` field, so a worker
cannot self-accept its own output. `CheckReceipt` records one deterministic check execution
(profile/version, executable/args identity, environment/input/source digests, exit code,
outcome, optional test counts). `ReviewReceipt` records independent criterion verdicts,
distinguishable from a measured check. Only `AcceptanceRecord` is the host's own decision: it
cites the candidate's proposal digest and input fingerprint, requires at least one check or
review receipt ID when `decision === "accepted"`, and carries the deciding policy revision
and an optional invalidation. These are the records that a journal `result_proposed` event's
`proposalDigest` and an `acceptance_decided` event's `receiptIds` refer to.

## Validation

`validateGraph(input: unknown)` never throws. It first runs `parseDto` against
`GraphSpecSchema` (strict schema parsing, mapping Zod issues to `schema_invalid`, or
`unsupported_schema_version` when the input's `schemaVersion` differs from the current one).
On success it then checks every semantic invariant and collects **all** issues rather than
stopping at the first: `duplicate_node`, `unknown_edge_endpoint`, `self_edge`,
`duplicate_edge`, `cycle`, `root_has_owner`, `child_missing_owner`, and
`delegation_beyond_depth` (a depth-2 grandchild node cannot request further child graphs).
Each `ValidationIssue` carries a closed `code`, a `path`, and a `message`.

A `ValidatedGraph` is a branded type only `validateGraph` can produce; `getReadyNodes` accepts
only that type and never reparses. `topologicalOrder` runs Kahn's algorithm with ties broken
by node declaration order, giving a deterministic order for both display and scheduling.
`parseGraphSpec` is a throwing wrapper over `validateGraph` for callers that want an
exception; its message lists every issue's code and text.

Cross-graph ownership existence, parent/child depth increments, inherited permissions,
global node limits, budget reservation, and requirement coverage require supervisor state
and are not checked by this package alone.

## The run reducer

`decide(state, event) → { state, commands, rejection? }` (`run/decide.ts`) is a total, pure
state machine for one flat graph, driven by the versioned journal events in `run/events.ts`.
It never throws; stale, duplicate, or out-of-order events return a typed `rejection` and
leave `state` unchanged. It covers dispatch reservations under a concurrency limit (`RunPolicy`
on `run_started`), bounded retries per node, `result_ready` versus `accepted` dependency
edges, fencing tokens, host acceptance decisions, and cancellation. `decide` emits
reducer-internal `Command`s (`run/commands.ts`: `dispatch`, `evaluate_acceptance`,
`cancel_attempt`, `complete_run`) for the host to turn into effects and report back as new
events. `replay(events)` (`run/replay.ts`) folds `decide` over a committed event log; this is
the same code path recovery uses to rebuild a run's state.

Acceptance is idempotent per attempt: once an `acceptance_decided` has settled an attempt
(accepted or rejected), a later decision for that same attempt is rejected rather than
re-applied. Cancellation reconciles outstanding acceptance evaluations before becoming
terminal: a cancelling run only reaches `cancelled` once every permit is released and no node
is still awaiting its `evaluate_acceptance` decision.

`RunState` (`run/state.ts`) is plain, readonly, JSON-serializable data: no `Map`/`Set`, and
every optional dimension is `null` rather than an omitted key, so `canonicalJson`/deep-equal
compare two states structurally instead of tripping over `undefined` vs. missing properties.

`test/sim/` is a seeded deterministic simulation (`simulate(seed)`) that drives `decide`
through a fake host/worker/acceptance gate over random small graphs, checking scheduler
invariants (permit accounting, no double-dispatch, dependency ordering, no dispatch after
cancellation, idempotent acceptance decisions, no outstanding `evaluate_acceptance` at a
terminal state, liveness, and `replay` agreement) after every applied event. `sim.test.ts`
runs a fixed, fast seed set; `npx tsx packages/core/test/sim/sweep.ts [count] [startSeed]`
runs a longer sweep and exits non-zero on any failing seed.

Scheduling across a graph hierarchy, budgets, and recovery extend this same reducer later;
there is no second state machine.

## Journal events

`run/events.ts` defines the wire vocabulary the reducer consumes: a Zod `discriminatedUnion`
on `type`, `JournalEventSchema`, with a strict schema per event and `parseJournalEvent`
(never throws; typed issues like every other parser here). Every event carries
`schemaVersion`, a globally unique `eventId`, the owning `runId`, and `at` (an `iso.datetime`
the host stamps, never model output).

| Event | Carries | Meaning |
| --- | --- | --- |
| `run_started` | `graph`, `policy` (`RunPolicy`: `maxConcurrent`, `maxAttemptsPerNode`) | The host admitted a run for this graph under this policy |
| `attempt_dispatched` | `nodeId`, `attemptId`, `fencingToken` | The persisted dispatch intent, recorded before the worker launch effect runs |
| `result_proposed` | `attemptId`, `fencingToken`, `proposalDigest` | A worker's own claim about its output; cannot self-accept |
| `acceptance_decided` | `nodeId`, `attemptId`, `decision`, `receiptIds` | The host's own acceptance gate outcome (an input to the reducer, not something it computes) |
| `attempt_failed` | `attemptId`, `fencingToken`, `category` (`FailureCategory`) | The attempt ended without a result |
| `lease_expired` | `attemptId`, `fencingToken` | The host declared the attempt's lease lost |
| `cancel_requested` | `reason` | Operator- or host-initiated cancellation of the run |
| `attempt_stopped` | `attemptId` | A worker confirmed it stopped after `cancel_requested` |

Fencing tokens are checked against the exact attempt they were issued to: an event whose
token does not match its attempt's stored token is rejected, never silently accepted. The
dispatch protocol — persist `attempt_dispatched` before running the dispatch effect, report
outcomes only as new events, answer `evaluate_acceptance` with `acceptance_decided` — is
documented on `run/commands.ts`. See [decision 0001](../../docs/decisions/0001-engine-pure-reducer.md).

## Session events

`session.ts` defines `SessionEventSchema`, a Zod discriminated union on `type`: `usage`,
`tool_call`, `tool_result`, `settled`, and `error`. A `usage` event carries a nested
`qualification` of `"reported"` (with `inputTokens`/`outputTokens`, and optional
`cacheReadTokens`/`cacheWriteTokens`) or `"unknown"`; per the budget state machine in the
design document, unknown usage is never reported as zero. Every `usage` event also
carries `source` (`turn` or `compaction`) so accounting can attribute summary calls.
`tool_call` and `tool_result` carry a `callId` and, respectively, a `toolName` or an
`isError` flag. `settled` carries a closed `reason` (`completed`, `aborted`, `error`); it
reports that the underlying session stopped producing output, not that a host accepted any
resulting work. `error` carries a bounded `message` (`MAX_SESSION_ERROR_MESSAGE_LENGTH`, 2000
characters) and is never a place for credentials or raw provider payloads.

`CodingSession` is the provider-neutral surface this package declares and
`@auto-pi-lot/pi` implements: `prompt`, `abort`, `dispose`, and a `subscribe` that returns
an unsubscribe function. `session.ts` imports only `zod` and is also exported as the
`./session` subpath, so consumers that need only the session port never load the run reducer
or graph validation.
