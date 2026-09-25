# auto-pi-lot

[![checks](https://github.com/sebastianspicker/auto-pi-lot/actions/workflows/ci.yml/badge.svg)](https://github.com/sebastianspicker/auto-pi-lot/actions/workflows/ci.yml)
[![pages](https://github.com/sebastianspicker/auto-pi-lot/actions/workflows/pages.yml/badge.svg)](https://sebastianspicker.github.io/auto-pi-lot/)

**In short.** auto-pi-lot is an early-stage project that will add a "graph mode" to the
[Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). In graph
mode, a coding task is split into a plan of smaller tasks, each task is run by an AI agent
with limits on retries, and no result is trusted until ordinary, non-AI code has checked it.
Today only the decision-making core exists and is tested; it does not yet run real tasks.
You can watch that core make decisions in the
**[interactive trace viewer](https://sebastianspicker.github.io/auto-pi-lot/)**.

> **Status: early foundation.** Built and tested: checking that a plan is well formed, the
> decision function that runs a plan (the *reducer*), and the connection to Pi sessions.
> Not built yet: saving state to disk, launching worker processes, the background
> supervisor, and the `/graph on` command, so nothing runs real tasks end to end yet. See
> the [roadmap](docs/roadmap.md). [README: Status]

*About this page.* It is a plain-language edition of the project README, written for
software engineers and engineering leads who use AI coding tools but do not know this
project's internals. Bracketed references such as [README: Tour] point to the section of the
original document this edition was rewritten from; the originals are in the Git history at
commit `bf04bd0`. Terms in *italics* on first use are defined in the [glossary](#glossary).

## Why this exists

The project treats anything a model says about its own work as a claim to be checked, not
a fact. Its rule is **agents propose, the harness decides** [README: intro]. A model may
suggest a plan or report that its work is done. Deterministic code, meaning code that always
gives the same answer for the same input and never calls a model, checks the plan, schedules
each *attempt*, enforces limits and decides whether a result is accepted. Throughout these
documents, the *harness* is auto-pi-lot as a whole and the *host* is the non-AI program
inside it that drives the decisions and carries them out.

## See it working: the trace viewer

The [trace viewer](https://sebastianspicker.github.io/auto-pi-lot/) replays real output from
the reducer. A scripted host sends *events* (messages such as "this attempt started" or
"this worker proposes a result"), and the reducer decides what happens next. Nothing in the
viewer calls a model [README: Tour].

### A run, step by step

![Happy path: verify starts while implement's result is still unverified](docs/images/tour-happy-path.png)

The example plan has three tasks: *implement*, then *verify*, then *review*. The link from
implement to verify only **needs a result**, so the verifier may start on a result that
nobody has accepted yet; that is its job. The link from verify to review **needs an accepted
result**, so the reviewer waits until the host has accepted the verification. Each step shows
the event, whether the reducer applied it, and the instructions (*commands*) it hands back to
the host. [README: A run, step by step]

### Retries and stale workers

![Retry and fencing: a late result from an old attempt is rejected](docs/images/tour-retry-fencing.png)

When an attempt fails, the reducer schedules a new attempt with a new ID and a higher
*fencing token*, a number that goes up with every new attempt. A late message from the old
attempt, or one carrying the wrong number, is rejected and changes nothing. This protects
against a crashed or slow worker overwriting the work of its replacement [Design §10;
Acceptance scenarios AT-19]. Rejected events are marked in red in the viewer's journal,
together with the typed reason. [README: Retries and stale workers]

### Cancellation

![Cancellation: running work is stopped and nothing new is dispatched](docs/images/tour-cancellation.png)

Cancelling a run stops running attempts and cancels work that has not started. The run is
only marked cancelled once every outstanding acceptance decision has been answered. Events
that arrive after that point are rejected. [README: Cancellation]

## Try it yourself

You need Node.js 22.19 or newer. You do not need any model credentials, and nothing below
calls a model or costs money [README: Quick start].

```sh
git clone https://github.com/sebastianspicker/auto-pi-lot.git
cd auto-pi-lot
npm ci --ignore-scripts
npm run check        # build, tests, lint, import boundaries, docs checks
npm run demo         # print a validated example graph and its ready nodes
node packages/cli/dist/index.js trace   # print the scripted run traces as JSON
```

To load the Pi extension, build first and point Pi at it:

```sh
pi --extension ./packages/pi/dist/extension.js
```

For now, the `/graph` command only reports that graph mode is not available yet.

## How it works, in four ideas

1. **A plan is data that gets checked.** A plan is a *task graph*: tasks (*nodes*) connected
   by dependencies (*edges*). It is read strictly and checked for duplicate task names, links
   to tasks that do not exist, circular dependencies, ownership and nesting depth. Only a
   plan that passes gets the `ValidatedGraph` type, and the rest of the system accepts
   nothing else. [README: How it works]
2. **One decision function runs the plan.** `decide(state, event)` takes the current state
   and one event, and returns the next state plus commands for the host, such as "start this
   attempt" or "check this result". Stale, duplicate or out-of-order events are rejected with
   a typed reason. After a crash, the host recovers by feeding the saved events through the
   same function again (*replay*). [README: How it works]
3. **Results are proposals.** A worker's result stays *unverified* until the host's
   *acceptance gate* decides. Each link between tasks says whether the next task needs any
   result (`result_ready`) or an accepted one (`accepted`). [README: How it works]
4. **Model providers stay at the edge.** The core knows nothing about Pi or any model API.
   The Pi adapter translates Pi's session events into neutral ones, and it never reports
   missing token usage as zero, because "unknown" and "zero" mean different things for a
   budget. [README: How it works; Design §7]

The complete target design, including tasks that start their own sub-plans, budgets,
separate workspaces and crash recovery, is in the [design document](docs/design.md). Most of
it is not built yet.

## What is in the repository

| Path | Contents |
| --- | --- |
| [`packages/core`](packages/core/README.md) | The deterministic core: data formats, plan checking, the reducer, evidence records and the interface to model sessions |
| [`packages/pi`](packages/pi/README.md) | Everything that touches the Pi software development kit (SDK): the session adapter and the `/graph` extension |
| [`packages/cli`](packages/cli/README.md) | The `demo` and `trace` commands, and later the local supervisor |
| [`site/`](site) | The trace viewer published to GitHub Pages |
| [`docs/`](docs/architecture.md) | Architecture, design, roadmap and decision records |

The rules about which package may use which (for example, only `packages/pi` may use the Pi
SDK) are checked automatically by the Biome linter as part of `npm run lint`. [README:
Repository layout]

## Further reading

- [Architecture](docs/architecture.md): what exists today, how the packages are separated, and
  where new code goes.
- [Design](docs/design.md): the complete product the project is building toward.
- [Roadmap](docs/roadmap.md): milestones and current status. The
  [ledger](docs/implementation-ledger.json) has the details per work package.
- [Acceptance scenarios](docs/acceptance-matrix.md): the failure cases the finished system must
  handle before it can be called done.
- [Decision records](docs/decisions/README.md): why things are the way they are.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md). Coding agents working in this repository follow
[AGENTS.md](AGENTS.md).

[MIT](LICENSE) © 2026 Sebastian Spicker

## Limitations

- The project cannot yet run a coding task. Everything shown in the viewer is a scripted host
  driving the real decision function; there are no real workers, no saved state and no model
  calls. [README: Status; Architecture: What runs today]
- The benefits described above are design goals. Whether graph mode produces better coding
  results than a single Pi session has not been measured; that measurement is a planned,
  separately authorised step. [Roadmap: M3, M6; Design §14]
- The `/graph` command exists only as a placeholder.

## Glossary

| Term | Meaning here |
| --- | --- |
| Acceptance gate | The host's step that decides whether a proposed result is accepted, based on recorded evidence such as check results. |
| Attempt | One try at running a task. A retry is a new attempt with a new ID. |
| Command | An instruction the reducer hands back to the host, such as "start this attempt". The reducer never carries it out itself. |
| Deterministic | Always produces the same output for the same input; involves no model and no randomness. |
| Edge | A dependency between two tasks. `result_ready` edges need any result; `accepted` edges need an accepted result. |
| Event | A recorded message about something that happened, such as "attempt started" or "result proposed". |
| Fencing token | A number that increases with each new attempt. Messages carrying an old number are rejected, so an outdated worker cannot overwrite newer work. |
| Harness | auto-pi-lot as a whole: the system that plans, runs and checks agent work. |
| Host | The non-AI program that drives the reducer, stores events and carries out its commands. |
| Node | One task in a task graph. |
| Pi | The Pi coding agent, an AI coding assistant that runs in the terminal. |
| Reducer | The decision function `decide(state, event)`: given the current state and one event, it returns the new state and commands. It has no side effects. |
| Replay | Rebuilding the current state by running all saved events through the reducer again. |
| SDK | Software development kit: the library through which other programs use Pi. |
| Task graph | A plan: tasks and the dependencies between them, with no circular dependencies. |
| Unverified | The state of a result that a worker has proposed but the host has not yet accepted. |
