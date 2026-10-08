# Contributing

Thanks for looking. auto-pi-lot is a local, experimental tool: the deterministic core, the
host, the evidence gate and the Pi session worker exist, while worker processes, worktrees,
budgets, nested plans and the supervisor are still being built. Issues and focused pull
requests are welcome.

## Setup

You need Node.js 22.19 or newer and npm. No model credentials are needed for development.

```sh
npm ci --ignore-scripts
npm run check
```

`npm run check` builds every package and runs Biome (formatting, lint and import boundaries)
plus the Markdown link check. Tests, their fixtures and configuration, the simulation, and
ADRs are versioned. Before opening a pull request, also run `npm run test:types`, `npm test`,
and `npm run sim`. CI runs all four checks on Linux and macOS with Node 22.19 and 26.9.
The implementation ledger remains local and is not a CI gate.

Other useful commands:

| Command | What it does |
| --- | --- |
| `npm run format` | Apply Biome formatting and safe fixes |
| `npm test` | Run unit and integration tests (build first) |
| `npm run test:types` | Type-check the tests |
| `npm run sim` | Run the seeded reducer simulation over 2000 seeds |
| `npm run demo` | Print the example graph, its topological order and its ready nodes |
| `npm run fake-run` | Execute the example graph end to end through the host with stand-in workers, journaling to `.auto-pi-lot/` |
| `npm run site` | Regenerate `site/trace.json` for the trace viewer |

To view the trace viewer locally, run `npm run site`, then serve `site/` over HTTP (for
example `npx serve site` or `python3 -m http.server -d site`) and open it in a browser.

## Where things go

[docs/architecture.md](docs/architecture.md) explains the five packages, the enforced
import boundaries and where new code belongs. In short: deterministic decisions go in
`packages/core`, the host loop, the stores and the evidence gate in `packages/host`, running
attempts and checks in `packages/worker`, Pi SDK code in `packages/pi`, and wiring in
`packages/cli`. Further side effects (worker processes, the supervisor) become new packages
that depend on `core`.

## Pull requests

- Keep changes focused and describe how changed behavior was checked.
- Changes to wire formats or run semantics need a short written rationale in the pull
  request: the context, the decision and its consequences.
- Don't mark a work package as implemented without evidence; see the
  [roadmap](docs/roadmap.md).
- Never commit credentials, transcripts or local runtime state.
