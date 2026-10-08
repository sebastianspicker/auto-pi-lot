# 0013 — Serial evidence, run ownership, and cooperative deadlines

Implemented 2026-10-08 at the maintainer's direction; self-reviewed and automatically verified. Work packages AP-08, AP-11,
AP-12, AP-25 and AP-27. Supersedes 0011's permission for readers to observe a moving tree
and its real-worker concurrency default; extends 0012's lifecycle contract.

## Context

Writer slots only coordinate one run. Two CLI processes can otherwise edit one checkout or
append to one journal. Even within one run, a review overlapping another writer cannot claim
to have judged the producer's recorded tree. Checks may also change source. A stalled session
has no lifetime bound, and a normally exiting check can leave background processes writing.
The existing tests were excluded from Git, leaving those contracts untested in fresh clones.

## Decision

1. Real Pi runs require `maxConcurrent: 1` and at most one writer. Fake workers and the pure
   reducer retain concurrent scheduling. Existing concurrent journals cannot be resumed with
   Pi; limits remain immutable. Operators create a new run with a serial policy.
2. The CLI exclusively creates a workspace ownership file and a journal ownership file before
   model setup/dispatch. Standalone checks share the workspace lock. Files contain owner metadata
   and a unique token; cleanup removes only the matching owner's file after attempts settle.
   Locks are advisory for cooperating CLI processes, not a sandbox or a distributed lease.
3. Stale locks are never stolen automatically. After a crash or forced exit, the operator must
   confirm the previous process and check descendants have stopped before removing locks.
   SIGINT and SIGTERM request orderly cancellation. A second signal kills currently managed
   check groups and forces exit, leaving locks in place for explicit recovery.
4. Checkers require their starting fingerprint to equal the candidate's result revision.
   Read-only tasks that change source, and checks whose post-execution source fingerprint differs,
   fail with `effect_uncertain` without an acceptable proposal. Fingerprints do not capture ignored
   files, intermediate changes restored before comparison, or immutable snapshots. The operator
   must avoid outside edits; multi-producer plans should order review before subsequent writes.
5. Each node may specify `limits.timeoutMs` (positive, at most 24 hours; default 30 minutes).
   It covers setup, prompts, report repair and checks. Expiry requests abort and yields
   `deadline_exceeded` after cleanup. No retry is allowed to overlap a still-running writer.
   In-process sessions that ignore abort, or setup I/O that never settles, can still block;
   a hard deadline requires future worker-process isolation.
6. On POSIX, a check's process group ends when its direct process exits, times out or is cancelled.
   Output is drained for a bounded grace period; retained logs stay bounded in memory.
   Windows currently stops only the direct child and is not qualified for descendant cleanup.
7. `run --dry-run` performs a read-only plan preview before credential setup. `check` runs
   configured profiles without a model, records log artifacts and reports source drift. Neither
   baseline receipts nor simulated fake outcomes claim real task acceptance.
8. Tests, fixtures, test configuration, and ADRs are versioned. CI runs build, lint, links,
   test type checking, unit/integration tests and reducer simulation on Linux and macOS.
   The implementation ledger remains local; live model qualification requires explicit scope.

## Consequences

The product favors verifiable serial progress over parallel work on unstable source. Configs
created with concurrency 2 need migration; recorded policies remain immutable. Tests cover
host/worker/gate integration with real processes and durable stores without provider spend.
Worktrees, immutable reader snapshots, hard process deadlines, and protection from external
editors remain future work. Frozen resume configuration and final-tree verification are
implemented by [0014](0014-recorded-execution-and-final-verification.md).
