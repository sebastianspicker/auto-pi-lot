# @auto-pi-lot/host

The host: the first program that runs a task graph through the pure reducer `decide` from
`@auto-pi-lot/core`. `RunHost` owns time, event ids and every effect; the reducer only decides.
Imports `@auto-pi-lot/core` and Node built-ins only. See
[docs/architecture.md](../../docs/architecture.md), "How the host uses the reducer".

## The loop

Every event (a run start, a worker outcome, a gate verdict, a cancel request, the host's own
`attempt_dispatched`) goes through one serialized queue and follows the same steps:

1. **Check.** Stamp the event with schema version, id, run id and time, and parse it with
   `parseJournalEvent`.
2. **Decide.** Run `decide`. A rejected event is recorded in `host.rejections`; it is not
   persisted and the state does not change.
3. **Persist.** Append the accepted event to the journal. Only when the append resolved does
   the host state advance.
4. **Act.** Carry out the commands the event produced: persist `attempt_dispatched` and then
   start the worker, cancel an attempt, ask the gate, or complete the run.
5. **Report back as events.** Worker outcomes become `result_proposed`, `attempt_failed` or
   `attempt_stopped`; a gate verdict becomes `acceptance_decided`.

The host checks what comes in over its ports. A worker outcome that does not match
`WorkerOutcomeSchema` is a protocol violation by that worker: the attempt fails with category
`schema_invalid` and the issues are kept in `host.protocolViolations`. A `stopped` outcome for
an attempt the host never asked to stop is a worker that quit on its own; because a worker
reports only once, the host journals it as `attempt_failed` with category `worker_crashed`
rather than leaving the attempt (and its permit) hanging until a resume. A `cancel` with an
invalid reason returns `{ applied: false, reason: "invalid" }` and changes nothing. A gate
verdict that does not match `AcceptanceVerdictSchema` is a host bug (`GateProtocolError`).

A failed append, a gate that throws or answers invalidly, or a journal that cannot be read
stops the host: `host.failure` is set, `host.completion` rejects and no further event is
accepted. Running workers are not cancelled by that; the host has no authority left to do so.
`host.rejections` keeps the last 200 rejected events and `host.rejectedCount` the total.

## Ports

`RunHost.start(ports, graph, policy)` and `RunHost.resume(ports, runId)` take the ports defined
in `@auto-pi-lot/core`: `JournalStore` (durable append and read), `WorkerPort` (start and cancel
an attempt, outcomes come back through a callback) and `AcceptanceGate`. `clock` and
`newEventId` can be injected for deterministic tests.

## Fakes

`MemoryJournalStore`, `ScriptedWorker` and `ScriptedGate` stand in for real backends in tests and
demos. The worker follows a per-node script of outcomes and the gate a verdict function. Both
run in `immediate` mode, or in `manual` mode where `release(attemptId)` delivers the held answer,
which lets a test stop a run mid-attempt and simulate a crash. The memory store has a
`beforeAppend` fault hook and an `appended` log for ordering checks.

## Journal stores

- `MemoryJournalStore` keeps events in process memory, for tests and demos.
- `FileJournalStore(directory)` is durable. It writes one JSON Lines file per run,
  `<directory>/run-<encoded runId>.jsonl`, where the encoding keeps lowercase letters, digits,
  `-`, `_` and `.` and percent-encodes every other byte, so two run ids never share a file even
  on a case-insensitive file system and the name is never a path or a reserved device name. Each
  line is one `{seq, digest, event}` record: `seq` is 1-based and contiguous, `digest` is core's
  canonical SHA-256 of the event. A record is at most `MAX_RECORD_BYTES` (1 MiB; ids are bounded
  by core, so a well-formed event never reaches it). Every append is written completely and
  fsynced before it resolves (the directory too when the file is new); files are created with
  mode `0600` in a `0700` directory and are never opened through a symbolic link. Appends for one
  run are serialized within a store instance. The host never modifies a record it wrote; the only
  bytes it ever removes are an unreadable final fragment (next rule).
- Torn-tail rule: a last line that is cut short (no trailing newline) or that is not readable
  as UTF-8 JSON is a torn write: `read` returns the complete records before it with
  `tornTail: true`, and the next append truncates the fragment first. This is safe because the
  host acts on an event only after its append resolved, so no command of a torn record can have
  run. A line that is readable JSON but fails the key, sequence, schema, run-id or digest check,
  wherever it is, throws `JournalCorruptError` with the run, file and line number: a durable,
  acknowledged record is never deleted.

What the file store does not do:

- It is not tamper-evident. The per-line digest and sequence number detect accidental damage
  (bit rot, a torn write); anyone who can write the file can rewrite records with consistent
  digests. Local write access to the journal directory means the journal is trusted no further
  than that user.
- It has no inter-process lock. Two store instances or two processes appending to the same run
  will produce duplicate sequence numbers, which the reader then reports as corruption. Run one
  host per run; the AP-04 storage decision will settle locking with the backend.

The file store is interim until the AP-04 storage decision.

## Recovery on resume

`resume` reads the journal, replays it with `replay` and throws `JournalReplayError` if the log
does not replay cleanly. It keeps `recovery.tornTail` from the read. Then it reconciles, each
step persisted as an event:

- Every attempt that is `dispatched` or `stopping` gets a `lease_expired` event. The previous
  process owned those workers; the reducer retries under a new fencing token, so a late report
  from the old worker is rejected.
- Every node reserved by the reducer whose `attempt_dispatched` was never persisted is
  dispatched now.
- Every result still waiting for a verdict goes back to the gate. A second verdict for the same
  attempt is rejected by the reducer, so none is duplicated.

A run that is already terminal resolves `completion` at once and submits nothing.

## Limitations

- No real workers and no final storage backend yet: the file store is interim until the AP-04
  storage decision.
- No lease timer while a process is alive: a worker that hangs is never expired until a resume.
- No budgets.
- The journal file is not tamper-evident and has no inter-process lock (see "Journal stores").
