# 0015 — CLI Pi runs keep each attempt's session transcript on disk

Implemented 2026-10-21. Amends item 2 of [0012](0012-in-process-session-worker.md)
("in-memory transcript").

## Context

A failed attempt (`schema_invalid`, `worker_crashed`, `budget_exhausted`, `effect_uncertain`)
records no proposal, and the worker's progress lines are cut at 200 characters. With in-memory
Pi sessions nothing showed what the model read, ran or answered, so an operator could neither
diagnose the failure nor attach it to a bug report.

## Decision

1. `createPiSessionOpener` takes an optional `sessionDir`. With it, each session uses Pi's file
   session manager and writes Pi's JSONL transcript as `<timestamp>_sha256-<hex>.jsonl` (the
   attempt ID with `:` replaced, since Pi session IDs allow only letters, digits, `.`, `_` and `-`); without
   it the transcript stays in memory, as before. The worker passes the attempt ID in every
   `SessionOpenRequest`.
2. The CLI passes `<workspace>/.auto-pi-lot/sessions/run-<encoded runId>/`, created with mode
   0700, for every Pi run that opens sessions. `run` and `inspect` print it as `sessions`.
3. Transcripts are diagnostics, not evidence. They are not content-addressed, not referenced
   from the journal and never read by the gate; the attempt ID in the file name is the link.

## Consequences

- No journal, evidence or manifest schema changes; older runs simply have no directory.
- A transcript holds everything the model saw or printed, including tool output. Credentials
  are still never placed in the session, but a model can print what the operator's account can
  read, so transcripts are reviewed before they are shared. `.auto-pi-lot/` stays out of Git
  and outside the source fingerprint.
