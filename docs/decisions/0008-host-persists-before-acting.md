# 0008 — The host persists before it acts, and recovers by replay plus reconciliation

Accepted 2026-10-05. Work packages: AP-07 (host loop), AP-05 (journal), AP-14 (recovery).

## Context

Until now nothing drove the run reducer except scripted scenarios and the simulation. The
architecture page describes the protocol a host must follow (check, decide, save, act, report
back), and decision 0001 says recovery is replay. Neither said what a host does with the work
that was in flight when it crashed, nor where the boundary between the reducer's ports and
their first implementations lies. The first host had to settle both.

## Decision

1. **Ports live in `core`, implementations outside it.** `core/src/run/ports.ts` defines
   `JournalStore`, `WorkerPort` and `AcceptanceGate`, shaped by the reducer protocol only.
   The new package `@auto-pi-lot/host` implements the loop (`RunHost`) and ships an in-memory
   journal, a file journal and scripted fakes. `core` still imports only `zod` and
   `node:crypto`.
2. **One event at a time, persisted before any effect.** The host serialises every event:
   it parses it, runs `decide`, and if the reducer applied it, appends it to the journal and
   only then advances its state and carries out the commands. A rejected event is never
   stored. A `dispatch` command becomes an `attempt_dispatched` event first; the worker starts
   only after that event is durable. If the journal append fails, the host stops with a typed
   failure instead of acting on an unrecorded decision.
3. **The host, not the worker, writes the journal.** A worker reports a typed outcome
   (`result`, `failed`, `stopped`); the host turns it into the matching journal event with
   its own id, time and the assignment's fencing token. A worker cannot report an acceptance.
4. **Recovery is replay, then reconciliation from state.** On `resume`, the host replays the
   stored events (a log that does not replay cleanly is an error, not something to repair)
   and then derives the pending effects from the rebuilt state:
   - an attempt still `dispatched` or `stopping` belonged to a worker the previous process
     owned, so the host journals `lease_expired` for it; the reducer retries under a new
     fencing token and a late report from the old worker is rejected;
   - a node still `ready` with a reservation is a dispatch whose `attempt_dispatched` never
     reached the journal, so the host drives that dispatch again;
   - a node whose acceptance was requested but never decided is asked again; the reducer
     rejects a second decision for the same attempt, so this cannot double-accept.
5. **Torn tail.** A journal whose last line is cut short or is not readable as UTF-8 JSON is
   read up to the last complete record, and that fragment is treated as never written. This is
   safe precisely because of rule 2: no command of that event can have run. A record that is
   readable but fails its sequence, schema, run-id or digest check is corruption wherever it
   sits, including at the end: an acknowledged record is never deleted.
6. **The file journal is interim.** It is one append-only JSON Lines file per run with a
   sequence number and digest per record, flushed to disk on every append, with a bounded record
   size. It satisfies "survives a restart" for the fake-worker slice; the storage decision of
   AP-04 (SQLite or otherwise) stands and will replace it behind the same port.
7. **The port boundary is checked.** Worker outcomes and gate verdicts are parsed against
   schemas in `core/src/run/ports.ts` before the host builds an event from them. An invalid
   worker outcome fails that attempt (`schema_invalid`); an invalid gate verdict is a host
   fault. Ids on the wire are bounded (`MAX_ID_LENGTH`), as are receipt lists and cancel
   reasons, so no single report can grow a record or a file name without limit.

## Consequences

- `npm run fake-run` executes the example graph end to end through the real reducer with fake
  workers, which the project could not do before; it still calls no model.
- The lease-expiry rule means a crash costs the in-flight attempts their retry; nothing
  pretends to know what a dead worker did. Reconciling uncertain external effects (AP-14)
  is not part of this record.
- There is no lease timer while the host process is alive; a hung worker is only detected
  by a restart. That timer and worker processes are AP-08 and AP-14 work.
- The file journal is not tamper-evident (digests are unkeyed and unchained) and has no
  inter-process lock, so exactly one host may own a run's file at a time. Both are accepted
  for the interim store and belong to the AP-04 decision.
- `RunHost.start` refuses a run id that already has a journal; a run is continued only
  through `resume`.
- Ports are added to `core` only with their first implementation, as decision 0004 requires.
