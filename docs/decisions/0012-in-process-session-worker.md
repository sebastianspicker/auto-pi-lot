# 0012 — The first real worker runs Pi sessions in the host process

Accepted 2026-10-08. Work packages: AP-08 (worker), AP-09 (closed Pi SDK execution), AP-11 (checks).

Execution manifests and final-tree verification extend this decision in
[0014](0014-recorded-execution-and-final-verification.md).

## Context

The design (§10) describes workers as separate processes talking to a broker over IPC, with
leases, heartbeats and process-group termination. The host so far ran only the scripted fake
worker. A software engineer cannot use a harness that never calls a model.

## Decision

1. **A `worker` package, created with its first implementation** (decision 0004):
   `@auto-pi-lot/worker` depends on `core` only and holds `SessionWorker` (a `WorkerPort`), the
   check runner, the workspace fingerprint and the task packet builder. It never imports the Pi
   SDK: it is handed a `SessionOpener` that returns the provider-neutral `CodingSession`.
2. **The session opener lives in `pi`.** `createPiSessionOpener` resolves the model route once
   (a pinned `provider/id`, or the first model with credentials) and opens one closed session per
   attempt: in-memory transcript, no extensions, skills or prompt templates, only the tool
   allowlist the worker asks for, the worker's system prompt instead of Pi's, SDK retries off,
   the repository's own context files still applied as data. Credentials stay in Pi's store.
3. **Tool policy by role.** Planner, explorer and reviewer get `read`, `grep`, `find`, `ls`;
   verifier and falsifier add `bash`; implementer and integrator add `bash`, `edit`, `write`.
   The `bash` tool is not sandboxed: a worker that holds it has the operator's authority in the
   workspace, as design §9 already states for version 1. Pi's `read`, `grep`, `find` and `ls`
   tools accept absolute paths, so even a reader role can read any file the operator can,
   including credential files outside the workspace; confining them is Pi SDK work that this
   record does not claim.
4. **The worker enforces the node's limits itself.** It counts `tool_call` events against
   `maxToolCalls` and reported token usage against `maxTokens`, aborting the session and failing
   the attempt with `budget_exhausted`. Usage the SDK did not report is flagged as a limitation
   on the proposal, never counted as zero. There is no run-wide budget yet (AP-06).
5. **The report is a proposal.** The worker reads the model's final message, expects one fenced
   JSON block (`WorkReportSchema` for producers, `ReviewReportSchema` for checkers), allows one
   repair prompt for a malformed block, and otherwise fails the attempt with `schema_invalid`.
   It then fingerprints the workspace, runs the declared checks (writers) or records the review
   (checkers), stores the proposal and reports its digest. The host turns that into
   `result_proposed`; acceptance is decision 0010's.
6. **Checks run without a shell, with an environment allowlist**, a timeout that kills the
   process group, and bounded logs stored as artifacts. Provider credentials in the host's
   environment are not passed to repository commands.
7. **Cancellation is `abort`.** `cancel(attemptId)` aborts the session and kills a check that
   is running for the attempt; the worker reports `stopped`. An attempt that had already finished
   is unaffected. Checker sessions are opened without the repository's context files.

## Consequences

- `CodingSession` gains an `assistant_message` event (bounded text of each completed assistant
  message), mapped from the SDK's `message_end`, so the worker never reaches into the SDK.
- The worker is in-process: a hung session is detected only through the SDK's own abort, there
  is no lease timer and no process to kill (decision 0008's limitation stands). Worker processes,
  the broker and IPC remain AP-08 work and will implement the same `WorkerPort`.
- Final-payload admission (checking the exact request before it is sent, AP-09) is not
  implemented; the limits above are enforced after each event, so one oversized call can exceed
  them before the abort lands. The README states this.
- `cli` now depends on `pi`, `worker` and `host`; the import boundaries stay enforced.
