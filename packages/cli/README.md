# @auto-pi-lot/cli

Local composition entry point and the operator's command line. `demo`, `trace`, `validate` and
`run` with the default fake worker make no model calls; `run --worker pi` does.

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

## run

```
auto-pi-lot run [--graph <file> | --resume <runId>] [--worker fake|pi] [--workspace <dir>]
  [--config <file>] [--model <provider/id>] [--thinking off|low|medium|high] [--journal <dir>]
  [--max-concurrent <n>] [--max-attempts <n>] [--max-writers <n>] [--allow-warnings] [--quiet]
```

(`npm run fake-run` is `run` with no arguments.) Executes the example graph, or the plan in
`--graph`, end to end through `RunHost` from `@auto-pi-lot/host`, or resumes a run from its
journal by replay and reconciles whatever was still open (decision 0008). Every applied event is
appended to `<journal>/run-<encoded runId>.jsonl` before the host acts on it. `--graph` and
`--resume` cannot be combined; the limit flags are rejected with `--resume` (the journal records
the policy). A resume must say `--worker fake` or `--worker pi`, the kind the run was started
with, because the journal does not record it and the scripted gate must never decide a real
run; a fake resume of a run that has an evidence directory is refused. The workspace must be a
directory other than the file system root or your home directory. `--model`, `--thinking` and `--allow-warnings` only matter with `--worker pi`.

**Workers.** `--worker fake` is the default: the scripted worker and gate. With no `--graph` it
runs the example graph under a fresh run id and crashes `implement`'s first attempt so the journal
shows a retry under a new fencing token; with `--graph` every attempt succeeds. Nothing is written
under `.auto-pi-lot/evidence` for a fake run (it uses memory stores).

`--worker pi` requires `--graph` or `--resume`. It runs each attempt as a Pi session in the
workspace, runs the checks your configuration defines and accepts results on recorded evidence.
Be aware that it **spends model credit**, **edits the workspace in place**, is **not sandboxed**
(a worktree or the tool allowlist is not a sandbox), and **serialises writers** (default
`maxConcurrentWriters: 1`, decision 0011). It needs Pi credentials (log in once with `pi`) or a
model you name with `--model provider/id` (split at the first slash) or `model` in the
configuration. Before any session is opened it reads and validates the plan (invalid: exit 1,
issues printed like `validate`), checks that every `checks` entry names a configured profile
(`unknown_check_profile`: exit 1), and refuses a plan with lint warnings unless `--allow-warnings`
(the warnings are printed to stdout, exit 1). A missing credential or unknown model exits 1 with
the message. Press Ctrl-C once to cancel the run (`cancel_requested`, "operator interrupt":
sessions are aborted and a running check is killed); a second press exits 130 without waiting.
If the host itself stops (a corrupt store, a failed append), every running attempt is cancelled
and the command exits 1 with the reason. Worker log lines have control characters escaped.

**Configuration and state.** The workspace is `--workspace` (default: the current directory). The
configuration is `--config` (default `<workspace>/auto-pi-lot.json`, validated strictly with
`ProjectConfigSchema`: `schemaVersion`, `checks`, optional `model`, `thinkingLevel`, `policy`). A
missing default file means no checks; a missing `--config` file, or an invalid one, is exit 2.
The policy is the defaults (fake: 2 concurrent, 2 attempts per node; pi: also 1 writer), overridden
by `config.policy`, overridden by `--max-concurrent`, `--max-attempts` and `--max-writers`
(positive integers). Runtime state lives under `<workspace>/.auto-pi-lot/` (gitignored):
`journal/` (override with `--journal`), `evidence/` and `artifacts/`.

**Progress.** Unless `--quiet`, stderr gets one line per applied event (`HH:MM:SS`, event type,
`node=`, `attempt=` (first 12 characters after `sha256:`), `decision=`, `category=`, `reason=`)
and the worker's log lines prefixed `worker:`.

**Output** (stdout, JSON): `mode: "run"`, `worker`, for pi also `route` (`provider`, `id`) and
`workspace`, then `runId`, `journal`, `resumed`, `graphFile` (null for the example), `tornTail`,
`finalStatus`, `events` (summaries), `rejections`, `nodes`, `evidence` and `replayMatches`.
`evidence` maps each node id to its attempts: `{ attemptId, proposal?, checks, reviews,
acceptance? }`, built from the evidence store (empty lists for the fake worker). Output is not
deterministic (real clock, random ids); use `trace` for fixtures.

**Exit codes.** 0: the run succeeded and the journal replays to the live state. 1: the run ended
failed or cancelled, the arguments were wrong, the plan was invalid, had unknown checks or
unaccepted lint warnings, Pi could not be set up, or a run id that already has a journal was
started (use `--resume`). 2: the plan or configuration could not be read or is invalid, evidence
is corrupt, or replay and live state disagree.

## init

`auto-pi-lot init [--workspace <dir>] [--force]` writes `<workspace>/auto-pi-lot.json` and
`<workspace>/auto-pi-lot.plan.json` and refuses to overwrite either unless `--force` (exit 1,
naming the file). If the workspace `package.json` has scripts named `test`, `lint`, `typecheck`,
`check` or `build`, the configuration gets one check profile each (`npm run <name>`, 10 minute
timeout; data only, never run by `init`), otherwise `checks: []`. The plan has an `implement`
node (naming those checks) feeding a `review` node, and a `runId` of `<dirname>-<yyyymmdd-hhmmss>`;
change the `runId` for every new run of the same plan, because a run id with a journal cannot be
started twice. Prints `{ mode: "init", config, plan, checks }` (the two file paths and the check
ids, and `gitignored`: whether `.auto-pi-lot/` was appended to `.gitignore`) and a hint on
stderr. `--force` replaces regular files only, never a link. Exit 0, or 1 on bad arguments or an
existing file.

## inspect

`auto-pi-lot inspect <runId> [--workspace <dir>] [--journal <dir>]` replays the run's journal
and prints `{ mode: "inspect", runId, status, policy, tornTail, nodes, attempts, events,
evidence }`; `attempts` maps each attempt id to `{ nodeId, fencingToken, status, consumes,
invalidated }`. Read-only: it reads the journal and the evidence store and starts nothing. Exit 1
for an unknown run or bad arguments; 2 for a corrupt journal, a journal that does not replay, or
corrupt evidence.

## status

`auto-pi-lot status [--workspace <dir>] [--journal <dir>]` lists every `run-*.jsonl` in the journal
directory and prints `{ mode: "status", runs }`, newest activity first. Each run is `{ runId,
status, startedAt, lastEventAt, nodeCount, eventCount, graphId }`; the run id is read from the
first event, not the file name. A journal that cannot be read is reported in its own entry as
`{ runId: <file name>, error }`. A missing or empty directory prints `runs: []`. Read-only. Exit 0
(1 for bad arguments).

## artifact

`auto-pi-lot artifact <id> [--workspace <dir>]` writes the bytes of an artifact (for example a
check log named in a check receipt's `logArtifactIds`) from `<workspace>/.auto-pi-lot/artifacts`
to stdout; on a terminal, control characters are shown escaped, while piped output is byte-exact.
Exit 1 for an unknown id or bad arguments, 2 if the stored bytes do not match their hash.
