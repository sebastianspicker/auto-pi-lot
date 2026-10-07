# @auto-pi-lot/cli

Local composition entry point. No model calls or task execution.

- `node packages/cli/dist/index.js demo` (also `npm run demo`) prints a validated graph and its
  initial ready nodes without running anything.
- `node packages/cli/dist/index.js trace` prints a JSON trace (`formatVersion: 3`) of four scripted host scenarios
  (`happy-path`, `retry-and-fencing`, `cancellation`, `repair`) run through the real run reducer
  (`decide`) from `@auto-pi-lot/core`: every journal event sent in, whether the reducer applied
  or rejected it, the commands it emitted, and the resulting run, node and attempt state after each
  step (format 3 added the per-step `attempts` snapshot).
  Output is deterministic (fixed timestamps and event ids) so it can be diffed or committed as a
  fixture. `packages/cli/src/trace.ts` documents the output format; it is consumed by the
  GitHub Pages trace viewer in `site/`.

- `node packages/cli/dist/index.js validate <graph.json> [--strict]` checks any graph file with
  `validateGraph` from `@auto-pi-lot/core` and prints JSON. An invalid graph prints
  `{ mode, file, ok: false, issues }` with every issue's `code`, `path` and `message`. A valid
  one prints `ok: true`, a `graph` summary (`id`, `runId`, `depth`, `revision`, `nodeCount`,
  `edgeCount`), `topologicalOrder`, `readyNodeIds` and `warnings`, which come from `lintGraph`
  (advisory: isolated nodes, checkers without a producer, producers without a verifying node).
  Exit code 0 means the graph is valid; 1 means it is invalid, or valid with warnings under
  `--strict`; 2 means the file could not be read or is not JSON, or the arguments are wrong
  (the usage line goes to stderr).

- `node packages/cli/dist/index.js run [--journal <dir>] [--resume <runId> | --graph <file>]
  [--max-concurrent <n>] [--max-attempts <n>]` (also
  `npm run fake-run`) executes the example graph, or the graph file given with `--graph`, end to end through `RunHost` from
  `@auto-pi-lot/host` with the scripted fake worker and gate. The worker crashes `implement`'s
  first attempt so the journal shows a retry under a new fencing token. Every applied event is
  appended to `<dir>/run-<encoded runId>.jsonl` (default `.auto-pi-lot/journal/`, gitignored) before the
  host acts on it; the command prints the run id, the journal path, the events, any rejected
  events, the final node states and whether replaying the journal reproduces the live state.
  `--graph` runs your own plan: the file's `runId` is used as is, every attempt succeeds (the
  scripted crash is only for the example), an invalid graph prints its issues like `validate`
  and exits 1, and a run id that already has a journal exits 1 (use `--resume`). It cannot be
  combined with `--resume`. `--max-concurrent` and `--max-attempts` set the run policy
  (positive integers; the example defaults to 2 and 2).
  `--resume` rebuilds a run from its journal by replay and reconciles whatever was still open
  (decision 0008). Because `run` itself only exits once the run is terminal, a run started by
  this command is always complete when resumed; the recovery of a run interrupted mid-attempt is
  exercised by the host tests, not by this command. Exit code 0 means the run succeeded and the
  journal replays to the live state; 1 means the run ended failed or cancelled, the arguments
  were wrong or the graph was invalid; 2 means the graph file could not be read, or replay and
  live state disagree. Output is not deterministic (real clock, random ids); use `trace` for
  fixtures.

Supervisor commands will be added in the executable vertical slice.
