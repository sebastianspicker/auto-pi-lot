# @auto-pi-lot/cli

Local composition entry point. No model calls or task execution.

- `node packages/cli/dist/index.js demo` (also `npm run demo`) prints a validated graph and its
  initial ready nodes without running anything.
- `node packages/cli/dist/index.js trace` prints a JSON trace (`formatVersion: 2`) of four scripted host scenarios
  (`happy-path`, `retry-and-fencing`, `cancellation`, `repair`) run through the real run reducer
  (`decide`) from `@auto-pi-lot/core`: every journal event sent in, whether the reducer applied
  or rejected it, the commands it emitted, and the resulting run/node state after each step.
  Output is deterministic (fixed timestamps and event ids) so it can be diffed or committed as a
  fixture. `packages/cli/src/trace.ts` documents the output format; it is consumed by the
  GitHub Pages trace viewer in `site/`.

- `node packages/cli/dist/index.js run [--journal <dir>] [--resume <runId>]` (also
  `npm run fake-run`) executes the same example graph end to end through `RunHost` from
  `@auto-pi-lot/host` with the scripted fake worker and gate. The worker crashes `implement`'s
  first attempt so the journal shows a retry under a new fencing token. Every applied event is
  appended to `<dir>/<runId>.jsonl` (default `.auto-pi-lot/journal/`, gitignored) before the
  host acts on it; the command prints the run id, the journal path, the events, any rejected
  events, the final node states and whether replaying the journal reproduces the live state.
  `--resume` rebuilds a run from its journal by replay and reconciles whatever was still open
  (decision 0008). Because `run` itself only exits once the run is terminal, a run started by
  this command is always complete when resumed; the recovery of a run interrupted mid-attempt is
  exercised by the host tests, not by this command. Exit code 0 means the run succeeded and the
  journal replays to the live state; 1 means the run ended failed or cancelled; 2 means replay
  and live state disagree. Output is not deterministic (real clock, random ids); use `trace`
  for fixtures.

Supervisor commands will be added in the executable vertical slice.
