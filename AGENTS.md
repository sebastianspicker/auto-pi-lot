# auto-pi-lot

Local-first graph orchestration for the Pi coding agent. Agents propose work;
the harness validates plans, schedules attempts, enforces limits, and accepts results.

## Map

- `packages/core` — deterministic, provider-neutral domain: wire schemas, graph validation
  (`src/graph`), run reducer, events and evidence (`src/run`), and the session port (`src/session.ts`).
- `packages/pi` — all Pi SDK code: session adapter and the Pi extension (`/graph`).
- `packages/cli` — operator entry point and future composition root (`demo`).
- `scripts/` — repository checks, evidence fingerprint and the Claude Code Stop hook.
- `docs/architecture.md` — current boundaries and where new code goes. `docs/implementation-handoff.md`
  — target product design. `docs/implementation-ledger.json` — work packages and evidence.

## Working conventions

- Read `docs/architecture.md`, the handoff section you touch, the ledger entry, and the nearest
  package README before changing a boundary. Semantic changes need a short ADR in `docs/decisions/`.
- Keep TypeScript strict, ESM, and explicit at process, storage, and model boundaries.
- Validate external data with the schemas in `@auto-pi-lot/core`. Do not cast model output into trusted contracts.
- Keep Pi SDK imports inside `packages/pi`; it may import only `@auto-pi-lot/core/session`.
  `core` imports only `zod` and `node:crypto`. Biome enforces both (`npm run lint`).
- Put effects (storage, worker processes, supervisor) in new packages that depend on `core`,
  created with their first implementation. Add a port to `core` in the same change as its first implementation.
- Keep scheduling, policy, budgets, and recovery deterministic and independent of models.
- Pin direct dependencies and commit `package-lock.json`. Runtime state, credentials,
  transcripts, worktrees, and generated artifacts do not belong in Git.
- Describe scaffold interfaces as interfaces; do not claim persistence, sandboxing,
  or execution that has not been implemented and verified.
- Update implementation-ledger status with exact-source evidence for completed work;
  proposed acceptance scenarios and predecessor tests do not establish current passes.

## Commands

- `npm ci --ignore-scripts` — install the locked workspace dependencies.
- `npm run build` — build all packages with TypeScript project references.
- `npm test` — build, then run the deterministic tests (no model credentials needed).
- `npm run lint` — check formatting, lint rules and import boundaries with Biome (read-only).
- `npm run format` — apply Biome's formatting and safe lint fixes.
- `npm run ledger` — validate `docs/implementation-ledger.json` structure and cross-references.
- `npm run links` — check relative Markdown links across the repository resolve.
- `npm run fingerprint` — print exact-source evidence identity for the current working tree.
- `npm run check` — required build, test, lint (including boundaries), ledger and link checks before finishing a code change.
- `npm run sim` — longer seeded simulation sweep of the run reducer (5000 seeds; `check` runs a fixed subset).
- `npm run demo` — print the validated example graph and initial ready nodes; no agent execution.

## Architecture invariants

- Keep graph ownership, task dependencies, and attempt history separate.
- Root depth is 0; children are 1; grandchildren are 2 and cannot delegate further.
- Use DAG dependencies within a graph. Represent repair loops as bounded new attempts
  or graph revisions, never by introducing dependency cycles.
- One global scheduler owns runnable work. Parents waiting on children must release
  execution capacity and must not hold a resource their descendants need.
- Reserve child budgets atomically from the root envelope. Children cannot broaden
  inherited permissions, scope, acceptance criteria, or budgets.
- A model's success report is a proposal. Acceptance requires evidence tied to the
  exact input artifacts and code revision, including checks on the integrated tree.
- Isolate concurrent writers in worktrees; serialize integration. A worktree is not a sandbox.
- Persist intent before dispatch. Use idempotency keys, attempt IDs, leases, and fencing
  for recovery. Never assume arbitrary external effects execute exactly once.
- Graph revisions are immutable. Changed inputs invalidate dependent evidence.
- Propagate cancellation down and terminal outcomes up; preserve partial artifacts.
- Keep credentials outside task packets, artifacts, and model-visible logs.

## Verification

Run `npm run check` for code changes. Add focused tests for changed graph invariants,
state transitions, contracts, and failure recovery; use fake sessions for routine tests.
Real-provider checks must be explicit, optional, and cost-bounded. For docs-only changes,
inspect links and consistency. Future scheduler work must test nested waits, cancellation,
stale worker results, duplicate dispatch, budget exhaustion, and crash recovery.
`.claude/settings.json` only enforces `npm run check` before Claude Code stops; Codex and
any other agent without that hook must run `npm run check` before handing off.

## Delegation

The main agent owns architecture and integration. Delegate useful independent work
with disjoint file ownership; keep small edits local. Use `sol_worker` for implementation
and `sol_reviewer` for review. Sol agents may use bounded Luna exploration, checks, or
isolated edits. Do not revert other agents' work. Collect evidence and integrate before finishing.

## Working together

The user, Claude Code and Codex share this repository, and this file is the
guide both agents read.

- **Roles.** The user sets scope, approves irreversible or outward-facing
  actions, and commits. The agent the user starts implements; the other
  agent reviews. No agent accepts its own work.
- **One writer at a time.** Only one agent edits this checkout at a time.
  Before editing, read `.agents/handoff.md` if it exists and run
  `git status`; preserve changes you did not make.
- **Handoff.** When you stop with work in progress or ask for review,
  overwrite `.agents/handoff.md` (ignored by git, never committed) with:
  status (`in-progress`, `ready-for-review`, `changes-requested` or
  `accepted`), date, goal, files changed, checks run with exit codes, and
  open questions or risks.
- **Review.** Review the uncommitted diff against the goal in the handoff
  note. Report each finding as `file:line`, defect and evidence, and record
  the verdict in the handoff note. Do not rewrite the change unless asked.
- **Ready for review** means `npm run check` exits 0. Paste failures
  verbatim and name any check you skipped.
