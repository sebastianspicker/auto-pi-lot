# 0004 — Three packages; ports arrive with their implementations

Accepted 2026-09-24. Supersedes [0003](0003-port-location.md).

## Context

The workspace had seven packages for about 1.3k lines of source. `storage` and `worker` only
re-exported engine port types so that the ledger had ownership targets. The domain was split
between `contracts` and `engine` along no stable line. Graph validation, topological order
and the dependency rule lived in `contracts`, while readiness lived in `engine`. The split
produced duplicate vocabularies: two `AttemptStatus` types, `RunPolicy` both as an interface
and as a schema, and `NodeStatus` next to an identical `ProducerState`. Seven port interfaces
and several DTOs (`RunSpec`, `RunAmendment`, `SpawnRequest`, `GraphPatch`, `AttemptRecord`,
idempotency keys, `ChildResult`, `DEFAULT_POLICY`) had neither a producer nor a consumer.
Their only tests were their own schema tests. The Pi SDK version was pinned in two manifests.
A 330-line custom import scanner re-implemented rules that the pinned Biome version already
provides.

## Decision

- `@auto-pi-lot/core` holds the deterministic domain: wire schemas, canonical identity, the
  graph, run state, events, the reducer, evidence records and the session port. It imports
  only `zod` and `node:crypto`.
- `@auto-pi-lot/pi` holds all Pi SDK code: the session adapter and the extension. It imports
  only the `@auto-pi-lot/core/session` subpath.
- `@auto-pi-lot/cli` stays the operator entry point and composition root.
- A port or DTO is added in the same change that first produces or consumes it. The handoff
  §6 table remains the specification those future records must satisfy. The evidence records
  that the journal events already reference (`ResultProposal`, `CheckReceipt`,
  `ReviewReceipt`, `AcceptanceRecord`) stay.
- Effectful subsystems (storage, worker processes, supervisor) become new workspaces
  depending on `core`, created together with their first implementation.
- Boundaries are enforced by Biome (`noUndeclaredDependencies`, `noImportCycles`, and
  `noRestrictedImports` overrides that also forbid relative imports into another package).
  TypeScript project references do not catch those: they redirect such an import to the
  referenced package's build output.

## Consequences

- The dependency direction is `core ← pi` and `core ← cli`. The session subpath keeps
  SDK-coupled code away from run decisions without needing a separate `contracts` package.
- The ledger's proposed locations for unstarted work name `packages/core/src/...` for
  deterministic code. Storage and worker locations remain proposals for packages that do
  not exist yet.
- Removing a record from `core` loses no running guarantee, because nothing constructed or
  parsed it outside its own tests. Its future owner redefines it against a real consumer.
- `npm run boundaries` no longer exists; `npm run lint` covers it.
