# Architecture

This page describes the code that exists today and the rules for adding to it. The
[implementation handoff](implementation-handoff.md) specifies the complete target product;
the [ledger](implementation-ledger.json) tracks the work to get there.

## What runs today

- **Graph validation**: untrusted graph specs are parsed strictly and checked semantically. The
  result is either a branded `ValidatedGraph` or every typed issue that was found.
- **Run reducer**: `decide(state, event) → { state, commands, rejection? }` is a total, pure
  state machine for one flat graph. It covers dispatch reservations under a concurrency limit,
  bounded retries, `result_ready` versus `accepted` dependency edges, fencing, host acceptance
  decisions and cancellation. `replay(events)` folds it over a journal.
- **Session port and Pi adapter**: `CodingSession` is the session surface that the rest of the
  system consumes. It knows no provider. `openPiSession` implements it over the pinned Pi SDK
  and maps SDK events to provider-neutral session events.
- **Pi extension**: `/graph` reports development status. It starts nothing.
- **CLI**: `demo` prints a validated example graph, its topological order and its ready nodes.

Nothing here persists state, launches workers or calls a model. Effects exist only as the
reducer's commands and as the injected Pi session factory.

## Packages

| Package | Owns | May import |
| --- | --- | --- |
| [`@auto-pi-lot/core`](../packages/core/README.md) | The deterministic, provider-neutral domain: wire schemas and canonical identity, graph spec and validation, run state vocabulary, journal events, reducer and replay, evidence records, and the session port | `zod`, `node:crypto` |
| [`@auto-pi-lot/pi`](../packages/pi/README.md) | Everything coupled to the Pi SDK: the session adapter and the Pi extension entry point | `@auto-pi-lot/core/session`, Pi SDK |
| [`@auto-pi-lot/cli`](../packages/cli/README.md) | The operator entry point and future composition root | `@auto-pi-lot/core` |

```text
          @auto-pi-lot/core ──────────────┐
          │  (index: full domain)         │ ./session subpath (session port only)
          ▼                               ▼
   @auto-pi-lot/cli               @auto-pi-lot/pi ──► @earendil-works/pi-coding-agent
```

Dependencies point toward `core`, and `core` depends on no workspace. No package imports
`cli`. `pi` sees only the session port, so SDK-coupled code cannot reach into run decisions.

### Enforcement

| Rule | Mechanism |
| --- | --- |
| A workspace imports only dependencies declared in its own `package.json`. The Pi SDK is declared only by `pi`, and no package declares `cli`. | Biome `noUndeclaredDependencies` (`npm run lint`) |
| `core/src` imports only `zod`, `node:crypto` and its own modules | Biome `noRestrictedImports` override for `packages/core/src` |
| `pi` imports `@auto-pi-lot/core/session`, never the `@auto-pi-lot/core` root | Biome `noRestrictedImports` override for `packages/pi` |
| No import cycles, including type-only and cross-package cycles | Biome `noImportCycles` (`ignoreTypes: false`) |
| No relative import into another package's `src` or `dist` (TypeScript project references would silently accept it) | Biome `noRestrictedImports` override for `packages/*/src`, repeated in the `core` and `pi` overrides because an override replaces a rule's options |

## The reducer protocol

Journal events (`core/src/run/events.ts`) are versioned wire contracts. The host stamps them
and they are never model output. Commands (`core/src/run/commands.ts`) are requests for
effects. The host is expected to drive the reducer like this:

1. Parse input with `parseJournalEvent`. `decide` receives only validated events.
2. Apply the event with `decide`. A rejection leaves state unchanged and is not persisted as
   progress. Rejections cover stale fencing tokens, duplicates, wrong runs, terminal runs and
   invalid transitions.
3. Persist the accepted event, then perform the emitted commands. A `dispatch` effect may
   run only after its `attempt_dispatched` event has been applied without rejection.
4. Effects report back only as new events: `result_proposed`, `attempt_failed`,
   `lease_expired`, `attempt_stopped` and `acceptance_decided`.

Recovery is `replay` of the committed journal, followed by reconciliation of in-flight
effects ([decision 0001](decisions/0001-engine-pure-reducer.md)). A worker's result is a
proposal. Only `acceptance_decided`, produced by the host's acceptance gate, changes a
result's disposition to `accepted`.

## State

The journal will be the source of truth once storage exists (AP-04/AP-05). Run state is
derived from the journal. It is plain, JSON-serializable data, so replay and canonical
comparison are exact. Graph revisions are plan history, and `schemaVersion` is the wire
format version. They are independent.

## Where new code goes

- **Deterministic decisions** go in `core`, in `graph/` (the static plan) or `run/`
  (executing it). Examples: scheduling, budgets, hierarchy, loops. Extend the one reducer; do
  not build a second state machine.
- **Effects**, such as SQLite storage, worker processes, workspaces, the command broker and
  the supervisor, go in new workspaces that depend on `core`. Create each workspace together
  with its first implementation, not beforehand.
- **Port interfaces**, such as a journal store or a worker dispatcher, are added to `core`
  in the same change as their first implementation, shaped by what the reducer and that
  implementation actually need. `CodingSession` follows this rule: `pi` implements it.
- **Pi SDK usage** goes in `pi`. Split the extension into its own package when it gains a
  supervisor client with a different dependency set.
- **Wiring** concrete implementations together goes in `cli`.

## Repository tooling

`npm run check` runs build, test typecheck, unit tests, Biome lint/format, the ledger
validator and the Markdown link checker. `scripts/` holds those repository checks, the
exact-source fingerprint used for ledger evidence, and the Claude Code Stop hook. CI runs
`npm ci --ignore-scripts`, `npm run check` and `npm run demo` on the Node version pinned in
`.node-version`.
