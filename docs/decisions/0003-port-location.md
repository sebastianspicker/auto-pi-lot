# 0003 — Ports live in the engine; placeholder packages re-export

Accepted 2026-09-24. Work packages: AP-05, AP-08, AP-09. **Superseded by [0004](0004-three-packages.md).**

## Context

The design document (then §4, now §2) has the engine declare the ports it consumes, while the scaffold defined
`RunStore`, `ArtifactStore`, `WorkerAssignment` and `WorkerSessionFactory` in interface-only
`storage` and `worker` packages, and `CodingSession` in `pi-adapter`. The worker package
therefore depended on the Pi adapter for a provider-neutral type.

## Decision

- Engine-consumed ports live in `packages/engine/src/ports/` and are shaped around the
  reducer's events (for example, append events at an expected sequence).
- The provider-neutral session port and its event stream live in `@auto-pi-lot/contracts`
  (`session.ts`); `pi-adapter` implements it from Pi SDK events.
- `storage` and `worker` stay as workspaces that re-export their port types until AP-04 and
  AP-08 add implementations. They are not deleted, so ownership in the ledger is unchanged.

## Consequences

- Dependency direction: contracts ← engine ← storage/worker; contracts ← pi-adapter.
  Boundary rules enforce it.
- Implementations depend on the engine's port types, never the reverse.
