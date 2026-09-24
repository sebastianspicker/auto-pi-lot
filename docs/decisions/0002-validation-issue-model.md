# 0002 — Validation returns all typed issues

Accepted 2026-09-24. Work package: AP-01.

## Context

The scaffold's `validateGraphSpec` threw a plain `Error` at the first problem. Planner output
is untrusted and repaired in bounded loops (handoff §8), which needs machine-readable feedback,
and AT-03 requires typed rejections without state changes.

## Decision

Boundary validation returns `{ ok: true, value } | { ok: false, issues }`. Each issue has a
code from a closed enum, a path and a message. Graph validation collects every semantic issue
rather than stopping at the first, and never throws on arbitrary input. A successfully
validated graph carries a `ValidatedGraph` brand; engine functions accept only that type.
`parseGraphSpec` remains as a throwing convenience wrapper.

## Consequences

- Repair prompts and tests use issue codes, not message text.
- New semantic checks (AP-02) add issue codes; removing a code is a contract change.
- The engine no longer re-parses graphs on each call.
