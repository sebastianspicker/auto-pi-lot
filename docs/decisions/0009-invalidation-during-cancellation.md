# 0009: Rejection invalidates consumers during cancellation

Status: Accepted 2026-10-08 (reviewed by Claude Code on 2026-10-07; see the handoff note of commit dce7dae)

## Context

Cancellation waits for outstanding acceptance decisions. Previously, a rejection delivered
during cancellation settled only the producer. Consumers could retain accepted results bound
to that rejected attempt in the final cancelled state, contrary to decision 0007's candidate
binding and transitive invalidation rule.

## Decision

Apply the existing transitive consumer invalidation rule when a pending producer result is
rejected during cancellation. Proposed and accepted consumer attempts become `invalidated`;
their nodes become `cancelled`, clear their active attempt and withdraw acceptance requests.
They do not return to pending and no retry is dispatched.

An already-stopping consumer is marked invalidated without another stop command. It retains
its permit until it reports stopped, failed or lease-expired; a late proposal is rejected as
`stale_candidate`. Reservations were already dropped by cancellation. Unrelated results and
acceptance evaluations are unaffected. Completion still waits for all permits and remaining
acceptance evaluations to settle.

## Consequences

The cancelled state no longer presents results built on a rejected candidate as accepted.
Late decisions for invalidated candidates cannot restore their acceptance. Event and command
schemas are unchanged; replay uses the corrected reducer semantics. This does not add a way
to revoke an already-settled producer acceptance (the limitation in decision 0007 remains).

Regression tests cover transitive accepted and proposed results, dropped reservations,
stopping workers ending by all three paths, stale proposals and decisions, duplicate rejection,
unrelated acceptance, permit accounting and replay.
