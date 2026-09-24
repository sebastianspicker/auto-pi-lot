# @auto-pi-lot/cli

Local composition entry point. No model calls or task execution.

- `node packages/cli/dist/index.js demo` (also `npm run demo`) prints a validated graph and its
  initial ready nodes without running anything.
- `node packages/cli/dist/index.js trace` prints a JSON trace of three scripted host scenarios
  (`happy-path`, `retry-and-fencing`, `cancellation`) run through the real run reducer
  (`decide`) from `@auto-pi-lot/core`: every journal event sent in, whether the reducer applied
  or rejected it, the commands it emitted, and the resulting run/node state after each step.
  Output is deterministic (fixed timestamps and event ids) so it can be diffed or committed as a
  fixture. `packages/cli/src/trace.ts` documents the output format; it is consumed by the
  GitHub Pages trace viewer in `site/`.

Supervisor commands will be added in the executable vertical slice.
