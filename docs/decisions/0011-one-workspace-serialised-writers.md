# 0011 — One workspace per run; writers are serialised by the reducer

Accepted 2026-10-08. Reader concurrency and real-worker defaults are superseded in the
current implementation by [0013](0013-serial-evidence-and-run-ownership.md), pending review. Work packages: AP-11 (workspaces), AP-26 (reducer).

## Context

The design (§9) wants a merge workspace plus one worktree per concurrent writer, patches applied
one at a time and the checks rerun on the combined tree. None of that exists, and building it
before anything runs a real task would delay the product further. Yet two implementers editing
one directory at once would produce evidence about a tree neither of them owns.

## Decision

1. **One workspace per run.** The `run` command executes every attempt of a run in one directory
   (`--workspace`, default the current directory). There are no worktrees, no baseline capture
   and no merge step: the workspace *is* the operator's checkout, and the result is whatever the
   writers left there, plus the evidence.
2. **Writer slots in the policy.** `RunPolicy` gains optional `maxConcurrentWriters`. The reducer's
   dispatch loop reserves an attempt for a writer-role node (`implementer`, `integrator`,
   `isWriterRole`) only while fewer writers than that hold a permit; it skips a blocked writer
   and goes on to the next ready node, so readers keep flowing. The count is derived from the
   nodes that hold permits, never stored. Omitted, writers are bounded by `maxConcurrent`
   alone, which keeps every earlier journal and test unchanged; the real-worker composition
   passes 1.
3. **Evidence is bound to the tree.** Every proposal records the workspace fingerprint before
   (`baseRevision`) and after (`resultRevision`) the attempt: a SHA-256 over every tracked or
   untracked-but-not-ignored file (path, content, symlink target), excluding `.auto-pi-lot/`.
   Checks run against `resultRevision` while the writer still holds its permit, and the gate
   refuses a receipt about any other tree (decision 0010). A non-writer whose attempt saw the
   fingerprint change records that as a limitation on its proposal; it is not failed, because
   the change may be another attempt's (item 4).
4. **Readers may observe a tree in motion.** A reviewer runs after its candidate's result is
   proposed; with one writer slot and the usual `implement → review` shape nothing writes
   meanwhile. In a plan with independent writers a reviewer could read a tree another writer is
   changing. Its review is still bound to the candidate attempt and digest it was given, and the
   operator is told in the README that parallel writers in one workspace are not isolated.

## Consequences

- The reducer gains one policy field and one rule, tested directly and in the simulation (writers
  holding permits never exceed the slots; mixed-role random graphs still terminate and replay).
- Nothing protects the operator's uncommitted work beyond the fingerprint: `run --worker pi`
  edits the checkout in place, and the README says to run it on a branch or a clean tree.
  Baseline capture, worktrees and serial integration (design §9) stay planned work and will
  replace the one-workspace rule behind the same ports.
