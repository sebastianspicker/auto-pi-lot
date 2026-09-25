# Architecture

**In short.** Today auto-pi-lot is three small packages of code that make decisions but do
nothing else: they check plans, decide what should happen next in a run, and connect to Pi
sessions. Nothing saves state to disk, starts worker processes or calls a model yet. The code
is split so that the decision-making part (`core`) can never reach into the Pi-specific part,
and the linter checks this on every change. New capabilities that act on the world, such as
storage or worker processes, will go into new packages that depend on `core`. [Architecture:
What runs today, Packages]

*About this page.* It is a plain-language edition of the architecture page for engineers and
engineering leads who want to understand what the code does today and how it is organised,
without knowing its internals. Code names are kept in `code font` so the page still maps onto
the source. Bracketed references such as [Architecture: State] point to the section of the
original document this edition was rewritten from; the originals are in the Git history at
commit `bf04bd0`. Terms in *italics* on first use are defined in the [glossary](#glossary).
For the finished product see the [design document](design.md); for progress see the
[roadmap](roadmap.md) and the [ledger](implementation-ledger.json).

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
  a saved sequence of events through `decide` to rebuild the state. [Architecture: What runs
  today]
- **Session interface and Pi adapter.** `CodingSession` is the interface through which the
  rest of the system talks to an AI coding session. It knows nothing about any particular
  model provider. `openPiSession` implements it on top of the pinned version of the Pi
  software development kit (SDK) and translates Pi's events into neutral ones.
  [Architecture: What runs today]
- **Pi extension.** The `/graph` command reports the development status. It starts nothing.
- **Command-line tool.** `demo` prints a checked example plan, the order its tasks could run
  in, and which tasks are ready to start. `trace` runs three scripted scenarios through the
  real reducer and prints every step as JSON; the
  [trace viewer](https://sebastianspicker.github.io/auto-pi-lot/) (`site/`) replays that
  output. [Architecture: What runs today]

Nothing here saves state, launches workers or calls a model. Actions on the outside world
exist only as the reducer's *commands* (instructions for the host) and as the Pi session
factory that is passed in from outside. [Architecture: What runs today]

## Packages

| Package | Responsible for | May use |
| --- | --- | --- |
| [`@auto-pi-lot/core`](../packages/core/README.md) | The deterministic, provider-neutral core: data formats on the wire and their canonical identities, the plan format and its checking, the vocabulary of run states, journal events, the reducer and replay, evidence records, and the session interface | `zod` (a schema library) and `node:crypto` |
| [`@auto-pi-lot/pi`](../packages/pi/README.md) | Everything tied to the Pi SDK: the session adapter and the Pi extension entry point | Only the session part of core (`@auto-pi-lot/core/session`), and the Pi SDK |
| [`@auto-pi-lot/cli`](../packages/cli/README.md) | The operator's entry point (`demo`, `trace`) and, later, the place where all parts are wired together | `@auto-pi-lot/core` |

```text
          @auto-pi-lot/core ──────────────┐
          │  (index: full domain)         │ ./session subpath (session port only)
          ▼                               ▼
   @auto-pi-lot/cli               @auto-pi-lot/pi ──► @earendil-works/pi-coding-agent
```

All dependencies point toward `core`, and `core` depends on no other package in the
repository. No package uses `cli`. Because `pi` can only see the session interface, code tied
to the Pi SDK cannot reach into run decisions. [Architecture: Packages]

### How the rules are enforced

Each rule is checked automatically by the Biome linter when `npm run lint` runs, so a
violation fails the build rather than depending on review. [Architecture: Enforcement]

| Rule | Checked by |
| --- | --- |
| A package may only use libraries declared in its own `package.json`. Only `pi` declares the Pi SDK, and no package declares `cli`. | Biome `noUndeclaredDependencies` |
| Code in `core/src` may only use `zod`, `node:crypto` and its own files. | Biome `noRestrictedImports`, set for `packages/core/src` |
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
were in progress ([decision 0001](decisions/0001-engine-pure-reducer.md)). A worker's result
is only a proposal: only an `acceptance_decided` event, produced by the host's *acceptance
gate*, can change a result to `accepted`. [Architecture: The reducer protocol]

## State

Once storage exists (work packages AP-04 and AP-05), the event log (*journal*) will be the
source of truth, and the run's state will be derived from it. State is plain data that can be
written as JSON, so replaying events and comparing states give exact results. Two version
numbers are kept separate: a *graph revision* is the history of a plan's content, and
`schemaVersion` is the version of the data format. [Architecture: State]

## Where new code goes

- **Deterministic decisions** go into `core`: in `graph/` if they concern the plan itself, or
  in `run/` if they concern carrying it out. Examples are scheduling, budgets, nested plans and
  repair loops. They extend the one existing reducer; there must not be a second state
  machine.
- **Actions on the outside world** (*effects*), such as SQLite storage, worker processes,
  workspaces, the command broker and the supervisor, go into new packages that depend on
  `core`. Each such package is created together with its first real implementation, not in
  advance.
- **Interfaces to those effects** (*ports*), such as a journal store or a worker dispatcher,
  are added to `core` in the same change as their first implementation, and shaped by what the
  reducer and that implementation actually need. `CodingSession` already follows this rule:
  `pi` implements it.
- **Use of the Pi SDK** goes into `pi`. The extension moves into its own package once it gains
  a supervisor client with different dependencies.
- **Wiring the parts together** goes into `cli`. [Architecture: Where new code goes]

## Repository tooling

`npm run check` runs the build, the type check of the tests, the unit tests, Biome
(formatting, lint and the package rules above), the ledger validator and the Markdown link
checker. The `scripts/` folder holds these checks, the *exact-source fingerprint* used to tie
ledger evidence to a precise version of the code, and the Claude Code Stop hook. On GitHub, the
`checks` workflow runs `npm ci --ignore-scripts`, `npm run check` and `npm run demo` on the
Node.js version in `.node-version`. The `pages` workflow regenerates `site/trace.json` from the
same commit and publishes `site/` to GitHub Pages, so the viewer always shows the current
reducer's behaviour. [Architecture: Repository tooling]

## Limitations

- Everything on this page describes decisions, not execution: there is no storage, no worker
  process, no supervisor and no model call yet. [Architecture: What runs today]
- The reducer handles one flat plan. Nested plans, budgets and suspension are planned
  extensions of the same reducer, not existing features. [Architecture: What runs today, Where
  new code goes]
- "The journal is the source of truth" becomes true only once storage exists (AP-04, AP-05).
  [Architecture: State]

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
| Port | An interface in `core` describing an effect, implemented by another package. |
| Pure, total | A pure function has no side effects; a total function returns an answer for every input. |
| Reducer | `decide(state, event)`: returns the new state, commands, and possibly a rejection. |
| Replay | Rebuilding state by running saved events through the reducer again. |
| SDK | Software development kit: the library through which programs use Pi. |
| Task graph | A plan: tasks and their dependencies, with no circular dependencies. |
