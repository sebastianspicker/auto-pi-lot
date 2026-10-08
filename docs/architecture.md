# Architecture

**In short.** Today auto-pi-lot is five small packages: `core` makes the decisions (it checks
plans and decides what should happen next in a run), `host` drives those decisions against
pluggable *ports* (the event log, the workers, the evidence store and the acceptance gate) and
judges results from recorded evidence, `worker` runs one attempt at a time through a coding
session in your repository and runs your checks, `pi` connects to Pi sessions, and `cli` wires
it all together. A plan runs end to end with real Pi sessions (`run --worker pi`) or with the
fake worker, is journaled and survives a restart. The code is split so that the decision-making
part (`core`) can never reach into the Pi-specific part or into any effect, and the linter
checks this on every change. [Architecture: What runs today, Packages]

*About this page.* It is a plain-language edition of the architecture page for engineers and
engineering leads who want to understand what the code does today and how it is organised,
without knowing its internals. Code names are kept in `code font` so the page still maps onto
the source. Bracketed references such as [Architecture: State] point to the section of the
original document this edition was rewritten from; the originals are in the Git history at
commit `bf04bd0`. Terms in *italics* on first use are defined in the [glossary](#glossary).
For the finished product see the [design document](design.md); for progress see the
[roadmap](roadmap.md).

## What runs today

- **Plan checking.** A plan (*task graph*) arrives as untrusted data. It is read strictly
  against a schema, then checked for meaning. The result is either a `ValidatedGraph`, a type
  that only the checker can produce, or a list of every problem found, each with a typed
  reason. [Architecture: What runs today]
- **The run reducer.** `decide(state, event) → { state, commands, rejection? }` is the one
  function that decides how a run proceeds. It is *pure* (it only computes; it has no side
  effects) and *total* (it returns an answer for every possible input). It currently handles
  a single, flat plan, meaning no task starts a sub-plan. It covers: reserving a slot before
  starting an attempt, under a limit on how many run at once; a bounded number of retries;
  the two kinds of dependency ("needs a result" and "needs an accepted result");
  *fencing tokens*; the host's acceptance decisions; and cancellation. `replay(events)` runs
  a saved sequence of events through `decide` to rebuild the state. When a task runs out of
  attempts, the tasks waiting on it are marked failed rather than left waiting
  (decision 0006). An
  "accepted" decision must cite at least one receipt, or the reducer rejects it. [Architecture: What runs
  today]

  A task whose result other tasks check is accepted only after every checking task has an
  accepted result for that exact attempt. A failing finding rejects the task that produced the
  result: its next attempt names the rejection it repairs, and everything built on the
  rejected result is stopped or set back to waiting
  (decision 0005,
  decision 0007). How receipts turn into
  that finding is still the host's job.
- **The host.** `RunHost` (`packages/host`) is the loop the reducer protocol below describes:
  it parses each event, runs `decide`, appends the event to a *journal store*, and only then
  carries out the commands: it starts an attempt on the *worker port*, asks the *acceptance
  gate* for a decision, or cancels an attempt. Worker outcomes and gate verdicts come back as
  new events the host writes itself. `RunHost.resume` rebuilds a run from its journal by
  replay and then reconciles what was in flight (decision
  0008). The package ships an in-memory
  journal, a file journal (one append-only JSON Lines file per run) and scripted fakes for the
  worker and the gate, so the whole path runs without a model. [Architecture: What runs today]
- **Session interface and Pi adapter.** `CodingSession` is the interface through which the
  rest of the system talks to an AI coding session. It knows nothing about any particular
  model provider. `openPiSession` implements it on top of the pinned version of the Pi
  software development kit (SDK) and translates Pi's events into neutral ones.
  [Architecture: What runs today]
- **Evidence and the evidence gate.** `host` also stores evidence records (proposals, check
  receipts, review receipts, acceptance records) and artifacts (check logs) in content-addressed
  stores, and `EvidenceGate` answers the reducer's acceptance requests from those records
  alone: required checks must have passed against the exact tree the proposal names, no review
  of the candidate may have failed, and a checker's own attempt is accepted when its review is
  not unclear (decision 0010).
- **The session worker.** `SessionWorker` (`packages/worker`) runs one attempt: it builds a
  task packet from the node, the results it consumes and any rejection it repairs, opens a
  closed coding session with the tools its role allows, enforces the node's tool-call and token
  limits, reads the model's final report, fingerprints the workspace, runs the node's declared
  checks itself (no shell, environment allowlist, timeout) and stores the evidence. The run's
  writers are serialised by the reducer's writer slots (decision 0011). It is in-process, not a
  sandbox (decision 0012).
- **Pi session opener.** `createPiSessionOpener` (`packages/pi`) pins the model route and opens
  a closed Pi session per attempt: in-memory transcript, no extensions or skills, the worker's
  tool allowlist and system prompt, SDK retries off.
- **Pi extension.** The `/graph` command reports how to run graph mode from the command line.
  It starts nothing inside Pi yet.
- **Command-line tool.** `init` writes a starter `auto-pi-lot.json` (check profiles discovered
  from `package.json` scripts, as data) and an example plan for the repository. `validate`
  checks a plan file and lists its issues, warnings, task order and ready tasks. `run` executes
  a plan through the host: with `--worker pi` on your repository with real sessions and your
  checks, otherwise with the fake worker and gate. `inspect` shows a run's state and evidence,
  `status` lists runs, `artifact` prints a stored log. `demo` prints the example plan and
  `trace` runs four scripted scenarios through the real reducer for the
  [trace viewer](https://sebastianspicker.github.io/auto-pi-lot/) (`site/`). [Architecture:
  What runs today]

The actions on the outside world are the host's journal, evidence and artifact writes, the
worker's check processes, and the model calls made through the Pi session the `cli` composes.
Everything else exists as the reducer's *commands* (instructions for the host) and as the
ports the host is given. [Architecture: What runs today]

## Packages

| Package | Responsible for | May use |
| --- | --- | --- |
| [`@auto-pi-lot/core`](../packages/core/README.md) | The deterministic, provider-neutral core: data formats on the wire and their canonical identities, the plan format and its checking, the vocabulary of run states, journal events, the reducer and replay, evidence records, and the session interface | `zod` (a schema library) and `node:crypto` |
| [`@auto-pi-lot/host`](../packages/host/README.md) | The host loop (`RunHost`), the journal, evidence and artifact stores, the evidence gate, and the scripted fake worker and gate | `@auto-pi-lot/core` and Node's file system |
| [`@auto-pi-lot/worker`](../packages/worker/README.md) | The session worker, the check runner, the workspace fingerprint and the task packet | `@auto-pi-lot/core` and Node's file system and child processes |
| [`@auto-pi-lot/pi`](../packages/pi/README.md) | Everything tied to the Pi SDK: the session adapter, the session opener and the Pi extension entry point | Only the session part of core (`@auto-pi-lot/core/session`), and the Pi SDK |
| [`@auto-pi-lot/cli`](../packages/cli/README.md) | The operator's entry point (`init`, `validate`, `run`, `inspect`, `status`, `artifact`, `demo`, `trace`) and the place where the parts are wired together | `@auto-pi-lot/core`, `@auto-pi-lot/host`, `@auto-pi-lot/worker`, `@auto-pi-lot/pi` |

```text
          @auto-pi-lot/core ──────────────────────────┐
          │  (index: full domain, incl. ports)        │ ./session subpath (session port only)
          ├──────────────────┐                        ▼
          ▼                  ▼                 @auto-pi-lot/pi ──► @earendil-works/pi-coding-agent
   @auto-pi-lot/host   @auto-pi-lot/worker            │
          │                  │                        │
          └──────────────────┴────────────────────────┘
                             ▼
                      @auto-pi-lot/cli
```

All dependencies point toward `core`, and `core` depends on no other package in the
repository. No package uses `cli`, and `host`, `worker` and `pi` do not use each other: the
worker is handed a session opener and stores, it never imports them. Because `pi` can only see
the session interface, code tied to the Pi SDK cannot reach into run decisions, and because
`core` cannot import `host`, the reducer cannot reach the file system. [Architecture: Packages]

### How the rules are enforced

Each rule is checked automatically by the Biome linter when `npm run lint` runs, so a
violation fails the build rather than depending on review. [Architecture: Enforcement]

| Rule | Checked by |
| --- | --- |
| A package may only use libraries declared in its own `package.json`. Only `pi` declares the Pi SDK, and no package declares `cli`. | Biome `noUndeclaredDependencies` |
| Code in `core/src` may only use `zod`, `node:crypto` and its own files. | Biome `noRestrictedImports`, set for `packages/core/src` |
| Code in `host/src` may only use `@auto-pi-lot/core`, the Node built-ins `crypto`, `fs` and `path`, and its own files. | Biome `noRestrictedImports`, set for `packages/host/src` |
| Code in `worker/src` may only use `@auto-pi-lot/core`, the Node built-ins `child_process`, `crypto`, `fs`, `os` and `path`, and its own files. | Biome `noRestrictedImports`, set for `packages/worker/src` |
| `pi` uses `@auto-pi-lot/core/session`, never the whole of `@auto-pi-lot/core`. | Biome `noRestrictedImports`, set for `packages/pi` |
| No circular imports, including type-only ones and ones across packages. | Biome `noImportCycles` (`ignoreTypes: false`) |
| No file may reach directly into another package's `src` or `dist` folder. TypeScript's project references would otherwise quietly allow this. | Biome `noRestrictedImports`, set for `packages/*/src` and repeated in the `core` and `pi` settings, because a package-specific setting replaces the general one |

## How the host uses the reducer

The reducer decides; the *host* acts. *Journal events* (defined in `core/src/run/events.ts`)
are versioned data formats. The host creates and timestamps them; they never come from model
output. Commands (`core/src/run/commands.ts`) are requests for actions. The host is expected
to work in this order [Architecture: The reducer protocol]:

1. **Check the input.** Parse every incoming event with `parseJournalEvent`; `decide` only
   ever receives checked events.
2. **Decide.** Apply the event with `decide`. If it is rejected, the state stays exactly as it
   was and the event is not saved as progress. Reasons for rejection include a stale fencing
   token, a duplicate, the wrong run, a run that has already ended, and a transition that is
   not allowed from the current state.
3. **Save, then act.** Save the accepted event first, then carry out the commands it produced.
   A `dispatch` (start an attempt) may only happen after its `attempt_dispatched` event has
   been applied without rejection.
4. **Report back as events.** The results of actions come back only as new events:
   `result_proposed`, `attempt_failed`, `lease_expired`, `attempt_stopped` and
   `acceptance_decided`.

Recovery after a crash means replaying the saved event log, then reconciling any actions that
were in progress (decision 0001). `RunHost` does
exactly this: an attempt that was still running belonged to a worker the dead process owned,
so it is journaled as `lease_expired` and retried under a new fencing token; a reservation
whose `attempt_dispatched` never reached the journal is dispatched again; an acceptance that
was requested but never decided is asked for again (decision
0008). A worker's result is only a proposal:
only an `acceptance_decided` event, produced by the host's *acceptance gate*, can change a
result to `accepted`. [Architecture: The reducer protocol]

## State

The event log (*journal*) is the source of truth and the run's state is derived from it. The
host's file journal is an interim store, one append-only JSON Lines file per run; the storage
decision of work package AP-04 will replace it behind the same `JournalStore` port. State is
plain data that can be written as JSON, so replaying events and comparing states give exact
results. Two version
numbers are kept separate: a *graph revision* is the history of a plan's content, and
`schemaVersion` is the version of the data format. [Architecture: State]

## Where new code goes

- **Deterministic decisions** go into `core`: in `graph/` if they concern the plan itself, or
  in `run/` if they concern carrying it out. Examples are scheduling, budgets, nested plans and
  repair loops. They extend the one existing reducer; there must not be a second state
  machine.
- **Actions on the outside world** (*effects*), such as SQLite storage, worker processes,
  worktrees, the command broker and the supervisor, go into packages that depend on `core`:
  `host` for the loop, the journal and the evidence, `worker` for running attempts and checks,
  new packages for the rest. Each such package is created together with its first real
  implementation, not in advance.
- **Interfaces to those effects** (*ports*) are added to `core` in the same change as their
  first implementation, and shaped by what the reducer and that implementation actually need.
  `core/src/run/ports.ts` holds `JournalStore`, `WorkerPort`, `AcceptanceGate`, `EvidenceStore`
  and `ArtifactStore`; `host` implements all but the worker port, `worker` implements that
  one; `CodingSession` in `core/src/session.ts` is implemented by `pi`.
- **Use of the Pi SDK** goes into `pi`. The extension moves into its own package once it gains
  a supervisor client with different dependencies.
- **Wiring the parts together** goes into `cli`. [Architecture: Where new code goes]

## Repository tooling

`npm run check` runs the build, Biome (formatting, lint and the package rules above) and the
Markdown link checker. `npm test`, `npm run test:types` and `npm run sim` run the local-only
unit tests, their type check and the seeded reducer simulation. The `scripts/` folder holds the link checker and the *exact-source
fingerprint* used to tie evidence to a precise version of the code. On GitHub, the
`checks` workflow runs `npm ci --ignore-scripts`, `npm run check` and `npm run demo` on the
Node.js version in `.node-version`. The `pages` workflow regenerates `site/trace.json` from the
same commit and publishes `site/` to GitHub Pages, so the viewer always shows the current
reducer's behaviour. [Architecture: Repository tooling]

## Limitations

- The worker runs in the host process and the file journal and evidence stores are interim:
  there is no worker process, no broker, no supervisor and no SQLite yet (decisions 0008, 0012).
- One workspace per run, no worktrees, no baseline capture and no merge step: `run --worker pi`
  edits the checkout in place (decision 0011).
- While a host process is alive it has no lease timer: a session that never settles is only
  interrupted by cancelling the run or restarting (decision 0008).
- The reducer handles one flat plan. Nested plans, run-wide budgets and suspension are planned
  extensions of the same reducer, not existing features. [Architecture: What runs today, Where
  new code goes]
- One review suffices and a reviewer's `fail` rejects the producer; review agreement and
  counterexamples as required checks are not implemented (decision 0010).

## Glossary

| Term | Meaning here |
| --- | --- |
| Acceptance gate | The host's step that decides whether a proposed result is accepted. |
| Command | An instruction the reducer hands to the host, such as "start this attempt". The reducer never carries it out. |
| Deterministic | Always produces the same output for the same input; no model, no randomness. |
| Effect | Anything that acts on the outside world: writing files, starting processes, calling a model. |
| Exact-source fingerprint | A hash identifying the exact contents of the working tree, used to tie evidence to a precise code version. |
| Fencing token | A number that increases with each new attempt; messages carrying an old number are rejected. |
| Graph revision | A numbered version of a plan's content. Revisions are never edited, only superseded. |
| Host | The non-AI program that drives the reducer, stores events and carries out commands. |
| Journal, journal event | The ordered log of events for a run; one entry in it. |
| Lease | A time-limited claim that an attempt owns a piece of work; `lease_expired` reports that it ran out. |
| Port | An interface in `core` describing an effect, implemented by another package: the journal store, the worker port, the acceptance gate and the coding session. |
| Pure, total | A pure function has no side effects; a total function returns an answer for every input. |
| Reducer | `decide(state, event)`: returns the new state, commands, and possibly a rejection. |
| Replay | Rebuilding state by running saved events through the reducer again. |
| SDK | Software development kit: the library through which programs use Pi. |
| Task graph | A plan: tasks and their dependencies, with no circular dependencies. |
