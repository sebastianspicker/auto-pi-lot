# auto-pi-lot

Graph mode for the Pi coding agent: a local harness for autonomous coding and
problem solving with bounded loops, child graphs, and grandchild graphs.

**Status: early foundation.** Graph execution is not available yet. This repository contains
validated wire contracts and graph validation, a pure, simulation-tested run reducer, a Pi SDK
session adapter, a Pi extension status command and a plan-only CLI demo. Nothing persists
state or starts model calls.

## Development

Use Node.js 22.19.0 or newer and npm. No model credentials are required for these commands.

```sh
npm ci --ignore-scripts
npm run check
npm run demo
```

The demo prints a validated `implement → verify → review` graph and its initially
ready node. It does not execute tasks, write repository code, or persist a run.

After building, a compatible Pi installation can load the extension:

```sh
pi --extension ./packages/pi/dist/extension.js
```

`/graph` reports development status. `/graph on`, automatic planning, nested workers,
pause/resume, and recovery remain planned features; this command does not enable them.
`packages/pi` pins `@earendil-works/pi-coding-agent` to `0.87.0`.

## Workspace

| Package | Responsibility |
| --- | --- |
| [`core`](packages/core/README.md) | Deterministic, provider-neutral domain: wire schemas, graph validation, run reducer, evidence records, session port |
| [`pi`](packages/pi/README.md) | All Pi SDK code: session adapter and the `/graph` extension |
| [`cli`](packages/cli/README.md) | Operator entry point and plan-only demo |

[docs/architecture.md](docs/architecture.md) explains the boundaries, how they are enforced
and where new code goes.

Read [AGENTS.md](AGENTS.md) for contributor guidance and the
[full-project implementation handoff](docs/implementation-handoff.md) for the target runtime.
The [implementation ledger](docs/implementation-ledger.json) tracks work packages and evidence;
the [acceptance matrix](docs/acceptance-matrix.md) defines proposed verification scenarios.
Use the [roadmap](docs/roadmap.md) to navigate milestones. The
[scaffold handoff](docs/archive/scaffold-handoff.md) and [initial architecture](docs/archive/initial-architecture.md)
preserve the starting baseline; [decision records](docs/decisions/README.md) explain later changes.

The [pi-graph predecessor review](docs/reviews/pi-graph-2026-09-22.md) records patterns to
adopt or avoid, verification evidence, and recommended changes to the implementation sequence.

## Design commitments

- Agents propose work; deterministic code validates and controls execution.
- Graph ownership, dependencies, and attempt history are separate structures.
- Root graphs may own children; children may own grandchildren; depth is bounded at 2.
- One global scheduler and one root budget cover every descendant.
- Waiting parents release execution capacity. Concurrent writers use separate worktrees.
- Verification evidence names the exact candidate revision; integration requires new checks.
- Durable intent, immutable graph revisions, and idempotency support eventual recovery.

These are implementation requirements, not claims that the scaffold already enforces
every runtime invariant. See the roadmap for outstanding work.
