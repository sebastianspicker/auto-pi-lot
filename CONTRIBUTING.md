# Contributing

Thanks for looking. auto-pi-lot is early: the deterministic core exists, while execution,
storage and the supervisor are still being built. Issues and focused pull requests are welcome.

## Setup

You need Node.js 22.19 or newer and npm. No model credentials are needed for development.

```sh
npm ci --ignore-scripts
npm run check
```

`npm run check` builds every package, type-checks the tests, runs the test suite, and runs
Biome (formatting, lint and import boundaries) plus the ledger and Markdown link checks. CI
runs the same command.

Other useful commands:

| Command | What it does |
| --- | --- |
| `npm run format` | Apply Biome formatting and safe fixes |
| `npm run demo` | Print the example graph, its topological order and its ready nodes |
| `npm run site` | Regenerate `site/trace.json` for the trace viewer |
| `npm run sim` | Run the reducer simulation over 5000 seeds |

To view the trace viewer locally, run `npm run site`, then serve `site/` over HTTP (for
example `npx serve site` or `python3 -m http.server -d site`) and open it in a browser.

## Where things go

[docs/architecture.md](docs/architecture.md) explains the three packages, the enforced
import boundaries and where new code belongs. In short: deterministic decisions go in
`packages/core`, Pi SDK code goes in `packages/pi`, and wiring goes in `packages/cli`.
Anything with side effects (storage, worker processes) becomes a new package that depends on
`core`.

## Pull requests

- Keep changes focused and include tests for changed behavior. Reducer changes should keep
  `npm run sim` green.
- Changes to wire formats or run semantics need a short decision record in
  [docs/decisions/](docs/decisions/README.md).
- Don't mark a ledger work package as implemented without evidence; see the
  [roadmap](docs/roadmap.md).
- Never commit credentials, transcripts or local runtime state.

Coding agents working in this repository also follow [AGENTS.md](AGENTS.md).
