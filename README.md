# auto-pi-lot

[![checks](https://github.com/sebastianspicker/auto-pi-lot/actions/workflows/ci.yml/badge.svg)](https://github.com/sebastianspicker/auto-pi-lot/actions/workflows/ci.yml)

Run a coding plan through [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent),
check the resulting code with your repository's commands, and keep an inspectable record of
what passed, failed, or needed repair.

**Agents propose work; the harness accepts it from recorded evidence.** Each task gets its own
session, acceptance criteria, tool and token limits, deadline, and bounded retries. Checks run
as actual processes. Optional reviewer tasks judge the producer's criteria. Failed checks and
reviews feed evidence back into the next attempt.

This is an **experimental local tool for trusted repositories**. It edits your checkout in
place and uses your model credentials. It does not commit, push, or deploy your work. Worktrees,
a process sandbox, run-wide spending caps, nested plans, and a background supervisor are not
implemented. No claim is made that this outperforms a single coding session.

## Get started

Requires Node.js 22.19 or newer and npm. Model credentials are needed only for real Pi runs;
initialization, previews, baseline checks, and the scripted demo work without them.

```sh
git clone https://github.com/sebastianspicker/auto-pi-lot.git
cd auto-pi-lot
npm ci --ignore-scripts
npm run build
alias auto-pi-lot="node $PWD/packages/cli/dist/index.js"

cd ~/your/project
auto-pi-lot init
```

`init` discovers common npm scripts and writes two editable files:

- `auto-pi-lot.json`: check commands and default execution policy.
- `auto-pi-lot.plan.json`: an implementation task followed by an independent review.

Edit the plan's objective and acceptance criteria to describe your change. Keep criteria concrete:
“reject an empty email address with a validation error” gives the reviewer something to test.
Then establish a baseline and preview the plan:

```sh
auto-pi-lot check
auto-pi-lot run --worker pi --graph auto-pi-lot.plan.json --dry-run
```

`check` executes your configured commands without a model. Its JSON report includes exit status,
source identity, and log artifact IDs. It fails if a command fails or changes source during the
checks. Generated files should be covered by your repository's `.gitignore`.

`--dry-run` validates the graph, configured check references, lint warnings, concurrency policy,
run-ID availability, and existing ownership locks. It prints tasks, dependencies, effective
limits, selected check commands, and intended effects. It creates no files, runs no checks,
and does not load model credentials. `modelReadiness: "not_checked"` means provider availability
has not been tested; an omitted model remains `null` until Pi resolves it. Thinking defaults to `off`.

To execute, configure Pi credentials (`pi` login or provider environment variables), work on a
branch whose changes you can review, and run the following. Pi runs (including `--dry-run`)
require the workspace to be inside a git repository.

```sh
auto-pi-lot run --worker pi --graph auto-pi-lot.plan.json
auto-pi-lot status
auto-pi-lot inspect <runId>
auto-pi-lot artifact <logArtifactId>
```

Progress goes to stderr; the final structured JSON report goes to stdout. When a task's result
is rejected, the progress lines say why: a failed check, or a review that failed or left a
criterion unclear. An unclear verdict counts as a failed attempt, so write concrete criteria. `--quiet` suppresses
progress. Exit 0 means success; failed or cancelled runs exit 1. Journal replay or evidence
integrity failures may exit 2. Use `auto-pi-lot <command> --help` for syntax.

From inside Pi, start Pi in your project with
`pi --extension <auto-pi-lot clone>/packages/pi/dist/extension.js` and use
`/graph run <plan>`, `/graph cancel`, `/graph resume <runId>`, `/graph status` and
`/graph inspect <runId>`. They drive the same command-line tool as a child process; see
[`packages/pi`](packages/pi/README.md).

## Configure checks and limits

Check commands are executable/argument pairs, without a shell. They run under an environment
allowlist and a timeout; provider API keys are not inherited through the environment. Commands
the model runs with its `bash` tool get the same allowlisted environment (`PATH`, `HOME`, locale,
shell and temporary-directory variables, plus `CI=1`, `NO_COLOR=1` and `FORCE_COLOR=0`).
Anything else, such as `SSH_AUTH_SOCK` or proxy settings, is not passed on. This keeps exported API keys out of the model's
shell. It is not a sandbox: the model can still read any file your user can, including Pi's
credential store. They
still have your operating system user's file access. Only use commands and repositories you trust.

```json
{
  "schemaVersion": 1,
  "checks": [
    { "id": "test", "command": "npm", "args": ["test"], "timeoutMs": 600000 },
    { "id": "lint", "command": "npm", "args": ["run", "lint"], "timeoutMs": 120000 }
  ],
  "finalChecks": ["test", "lint"],
  "policy": { "maxConcurrent": 1, "maxConcurrentWriters": 1, "maxAttemptsPerNode": 2 }
}
```

Set each producer's `checks` to the profile IDs it must pass. `check --profile test` runs just
that baseline profile. Check working directories default to the workspace and must stay inside
it. Each check defaults to 10 minutes and can allow at most one hour.

After every task is accepted, all node-declared checks run again on the combined tree before
success is recorded. Add profiles to `finalChecks` for integration tests that need all tasks
finished. A failure at this stage fails the run; inspect `verification` and `finalChecks` in
`run` or `inspect` output for the reason, receipts and log artifact IDs. Final verification does
not automatically repair code. With no configured checks, this phase checks source stability
only; it provides no deterministic test coverage.

Each plan node has `limits.maxTokens`, `limits.maxToolCalls`, and optional `limits.timeoutMs`.
The attempt timeout defaults to 30 minutes, allows at most 24 hours, and includes session setup,
report repair, and checks. At expiry the worker requests cancellation, kills a running check's
process group on POSIX, and records `deadline_exceeded` after cleanup. An in-process SDK that
ignores cancellation can still stall; a replacement never starts while that attempt is active.
Token enforcement uses provider-reported usage; missing usage is recorded as unknown.
`maxTokens` is the sum, over every model call in the attempt, of the input and output tokens the
provider reports. Each call re-sends the conversation so far, so without prompt caching the total
grows much faster than the number of tool calls; cached input that the provider reports
separately is not counted. `init` starts the implementer at 1,000,000 and the reviewer at
500,000; an attempt that stops with `budget_exhausted` needs a higher limit or a smaller task.

Pin a model in config with `"model": { "provider": "…", "id": "…" }` or pass
`--model <provider/id>`. `--thinking off|low|medium|high` overrides the configured thinking level.
Limits on tokens and retries are not a monetary spending guarantee.

## Execution and recovery

Before the first attempt of a new Pi run, auto-pi-lot records a **restore point**. It is a commit
of the files in the git repository that contains the workspace, kept under
`refs/auto-pi-lot/restore/<runId>`. It includes uncommitted changes and untracked files that are
not ignored. It leaves out `.auto-pi-lot/`, and records submodules only as their commit, not
their files. HEAD, the index and your files are not
touched, and no hooks run. If the tree had uncommitted changes, the run warns and edits on top
of them. `run` prints the ref and reports it as `restorePoint`. To bring files back to that
state, run `git restore --source=refs/auto-pi-lot/restore/<runId> --worktree -- .` at the
repository root yourself. Files the run created are not removed by that; check `git status`.
auto-pi-lot never restores anything on its own. Delete old restore points with
`git update-ref -d <ref>`.

Real runs execute **one attempt at a time**. Checks and reviewers must not read a workspace
another task is editing. `maxConcurrent` and `maxConcurrentWriters` must both be 1 for Pi;
the fake worker and provider-neutral scheduler still support concurrent simulations.
Configurations created before this rule may need `policy.maxConcurrent` changed from 2 to 1.
Previously journaled concurrent policies cannot be changed by resume flags; use a new plan/run ID.

A reviewer must start from its candidate's recorded source revision. Source drift during a
read-only task or a check produces `effect_uncertain`, without an acceptable proposal. In plans
with multiple producers, order each producer's review before another writer changes the tree.
Source fingerprints cover tracked and untracked non-ignored files, excluding `.auto-pi-lot/`.
They are content identities, not snapshots or protection against outside editors.

The CLI holds exclusive ownership files for the workspace and journal until attempts finish.
This prevents cooperating CLI processes from editing one checkout or appending to one journal
concurrently. It does not restrict editors or arbitrary programs. `check` uses the same workspace
lock as a real run.

Press Ctrl-C once (or send SIGTERM) for cancellation and cleanup. A second signal forces exit;
ownership files remain deliberately. A crash or forced exit can also leave files at
`.auto-pi-lot/run.lock` and `<journal>/.writer.lock`. They contain the owner's PID, host, workspace,
and start time. **Confirm that the old process and its check descendants have stopped before
removing stale locks.** Automatic lock stealing is intentionally disabled.

```sh
auto-pi-lot run --worker pi --resume <runId>
```

Resume replays the journal and reconciles interrupted attempts. It requires an explicit worker
kind. Every new plan execution needs a fresh run ID: pass `--run-id <id>` to start the same plan
again without editing it. Resume does not restart terminal runs.
The first event freezes the worker, canonical workspace, resolved model, thinking level and
check commands. Resume uses that recipe even if the current config changes; `--config` and
conflicting overrides are refused. Interrupted final checks rerun. Completed runs need no
provider credentials. Legacy journals without an execution manifest remain inspectable, but
need a new run ID (`--run-id`) to execute with this version. The manifest does not snapshot source,
dependencies or the environment.

Keep `.auto-pi-lot/` out of Git; it contains journals, evidence, check logs, and session
transcripts. Each Pi attempt writes Pi's own JSONL transcript (prompts, model messages, tool
calls and their output, errors, and token usage) to
`.auto-pi-lot/sessions/run-<runId>/<timestamp>_sha256-<hex>.jsonl`, where `sha256:<hex>` is the
attempt ID (progress lines show its first 12 hex digits); `run` and `inspect` print the
directory as `sessions`. Use it to see what a failed attempt did. A transcript holds everything
the model read or printed, so review it before sharing. A custom Pi
journal must be outside the workspace or under `.auto-pi-lot/` so its writes do not change the
source fingerprint.

## Try it without a model

```sh
npm run fake-run
```

This drives the real scheduler and journal with scripted workers, including a crash and retry.
It fabricates results for demonstration and does not verify your repository. The
[trace viewer](https://sebastianspicker.github.io/auto-pi-lot/) illustrates acceptance, retries,
cancellation, and repair from reducer events.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm run test:types
npm test
npm run sim
```

Tests and ADRs are versioned. CI is configured to run build, formatting, import boundaries,
links, test type checking, unit/integration tests, and a 2000-seed scheduler simulation on
Linux and macOS with Node 22.19 and 26.9. The integration suite uses scripted model sessions
with real workspaces, subprocess checks, durable storage, the host, and the evidence gate.
Live model sessions remain a separate, explicitly authorized qualification step. POSIX process
group cleanup is implemented; Windows descendant cleanup is not qualified.

See [contributing](CONTRIBUTING.md), [architecture](docs/architecture.md),
[CLI reference](packages/cli/README.md), [decision records](docs/decisions/README.md),
and the [roadmap](docs/roadmap.md).
