# @auto-pi-lot/worker

The first real worker. `SessionWorker` implements the `WorkerPort` of `@auto-pi-lot/core`: it runs
one attempt of a task graph node through a provider-neutral `CodingSession` in a workspace
directory, runs the node's declared checks itself, records evidence and reports a typed outcome
(`result`, `failed` or `stopped`) to the host. The outcome is a proposal; acceptance stays with
the host's gate.

Everything it touches is injected (session opener, process spawner, file reader, clock,
fingerprint function), so it is tested without a model or a real process. It imports only
`@auto-pi-lot/core` and a few Node built-ins; the Pi session is supplied by the composition root.

## What it does

- **Session worker** (`src/session-worker.ts`). `start` returns at once and runs the attempt
  detached; it reports exactly one outcome per assignment. The attempt resolves the node's check
  profiles, fingerprints the workspace, loads consumed proposals and repair evidence from the
  evidence store, opens a session with the role's tools, prompts it with the task packet, parses
  the final `json` block (one repair prompt, then `schema_invalid`; a checker's verdicts must
  cover every acceptance criterion of the candidate's producer), fingerprints again, runs the
  checks (every non-checker role) or records a review receipt (checkers), stores the proposal
  with the ids of the receipts it recorded (`checkReceiptIds`; the gate counts nothing else) and
  disposes the session. `cancel` aborts the session and kills a running check. A thrown error is
  reported as `worker_crashed`.
- **Tool policy** (`src/tools.ts`). Planner, explorer and reviewer get `read`, `grep`, `find`,
  `ls`; verifier and falsifier add `bash`; implementer and integrator add `edit` and `write`.
  A role that is not a writer must leave the tree unchanged; source drift fails the attempt
  as `effect_uncertain`, without a proposal. Checkers also require the current source fingerprint
  to match their candidate before opening a session (decision 0013). Checker sessions are opened without the repository's context files, so
  a producer cannot steer its reviewer through `AGENTS.md`.
- **Limits.** Tool calls are counted from `tool_call` events and reported tokens (input plus
  output of `usage` events with `qualification: "reported"`) are summed; exceeding
  `limits.maxToolCalls` or `limits.maxTokens` aborts the session and fails the attempt with
  `budget_exhausted`. Unknown usage is never treated as zero: the proposal gets the limitation
  "token usage was not reported for at least one call" and the token limit is only enforced
  on what was reported. `limits.timeoutMs` defaults to 30 minutes (maximum 24 hours), covering
  setup, prompts, report repair and checks. Expiry aborts the session and running check; after
  cleanup the outcome is `deadline_exceeded`. Cancellation remains cooperative for session
  implementations and setup I/O: an unresponsive SDK can stall. `shutdown()` cancels and drains
  active attempts before the composition root releases workspace ownership.
- **Task packet** (`src/packet.ts`). A pure function that builds the prompt: role and
  boundaries, objective, criteria, node instructions (labelled data), declared checks, consumed
  results, repair evidence and the output contract. Every string another session wrote
  (summaries, claims, review notes, check logs) is inside a fenced block that the packet labels
  as data, so it cannot forge a heading or an instruction; quoted strings are bounded.
- **Check runner** (`src/check-runner.ts`). One executable and an argument list, no shell, in a
  directory inside the workspace, under a timeout. The child gets an allowlisted environment
  (`CHECK_ENV_ALLOWLIST` plus `CI=1`, `NO_COLOR=1`, `FORCE_COLOR=0`), so provider credentials do
  not reach a repository command through the environment (`HOME` stays, so a command can still
  read files). On POSIX, timeout, cancellation, and normal parent exit kill the process group; the `cwd` is checked
  lexically and again after resolving symbolic links. The log (stdout and
  stderr interleaved, last 256 KiB) is stored as an artifact, and the outcome comes from the real
  exit status: `pass` on exit 0, `fail` on any other exit or signal, `timeout`, or `error` when
  the process cannot start or the `cwd` leaves the workspace. The worker fingerprints source after each check and refuses a proposal if it changed. A node:test or TAP summary in the
  log becomes `testCount`.
- **Workspace fingerprint** (`src/workspace.ts`). `sha256` over one sorted line per file (content
  hash, symlink target string, or `deleted`), the same algorithm as `scripts/source-fingerprint.ts`.
  Files are listed with `git -c core.fsmonitor=false ls-files -co --exclude-standard` under the
  same allowlisted environment as a check, or by walking the directory when git is unavailable
  (skipping `.git`, `node_modules`, `.auto-pi-lot`). `.auto-pi-lot/` is always excluded and
  paths outside the root are skipped; a directory replaced by a symbolic link is not detected.

## What it is not

- Not a sandbox. The `bash` tool and the checks run with the authority of the user who started
  the harness; the environment allowlist and the cwd check limit accidents, not a hostile model.
- Not a separate process. The session runs in the host's process; a crash or a hung provider call
  is the host's problem until a supervisor exists.
- No worktrees. One workspace per run, so concurrent writers would share it; isolation and serial
  integration belong to a later package.
- Not an acceptance authority. It never reports `accepted`, and the review receipt it records is
  model judgment, kept apart from check receipts.

## Final-tree checks

`WorkspaceVerifier` implements `RunVerifier` independently of model sessions. It captures one
source digest, executes selected profiles, stores receipts and logs, and checks source stability
after each command. Drift fails the result and stops later checks. Cancellation drains subprocess
cleanup before completion. A recovered host constructs a new verifier and reruns unfinished
verification. Empty profile selection gives source-stability evidence only. See
[decision 0014](../../docs/decisions/0014-recorded-execution-and-final-verification.md).
