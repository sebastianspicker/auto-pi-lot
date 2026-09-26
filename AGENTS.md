# auto-pi-lot

Guidance for coding agents (Codex, Claude Code and others) working in this repository.
Human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md).

auto-pi-lot is local-first graph orchestration for the Pi coding agent. Agents propose work;
the harness validates plans, schedules attempts, enforces limits and accepts results.

## Map

- `packages/core`: deterministic, provider-neutral domain. Graph validation lives in `src/graph`,
  the run reducer, events and evidence in `src/run`, the session port in `src/session.ts`.
- `packages/pi`: all Pi SDK code, meaning the session adapter and the `/graph` extension.
- `packages/cli`: operator entry point (`demo`, `trace`) and future composition root.
- `site/`: the GitHub Pages trace viewer. `site/trace.json` is generated.
- `scripts/`: repository checks, the evidence fingerprint and the Claude Code Stop hook.
- `docs/architecture.md`: current boundaries and where new code goes.
  `docs/design.md`: target product design. `docs/implementation-ledger.json`: work packages and evidence.

## Conventions

- Read `docs/architecture.md`, the design section you touch, the ledger entry and the nearest
  package README before changing a boundary. Semantic changes need a short ADR in `docs/decisions/`.
- Keep TypeScript strict and ESM, and be explicit at process, storage and model boundaries.
- Validate external data with the schemas in `@auto-pi-lot/core`. Never cast model output into a trusted type.
- Pi SDK imports stay in `packages/pi`, which may import only `@auto-pi-lot/core/session`.
  `core` imports only `zod` and `node:crypto`. Biome enforces both (`npm run lint`).
- Effects (storage, worker processes, supervisor) go in new packages that depend on `core`,
  created with their first implementation. A port is added to `core` in the same change as its first implementation.
- Scheduling, policy, budgets and recovery stay deterministic and independent of models.
- Pin direct dependencies and commit `package-lock.json`. Runtime state, credentials,
  transcripts, worktrees and generated artifacts stay out of Git.
- Describe interfaces as interfaces. Do not claim persistence, sandboxing or execution
  that has not been implemented and verified.
- Change a ledger status only with exact-source evidence (`npm run fingerprint`). Proposed
  acceptance scenarios and predecessor tests are not current passes.

## Commands

- `npm ci --ignore-scripts`: install the locked workspace dependencies.
- `npm run build`: build all packages with TypeScript project references.
- `npm test`: build, type-check tests, run the deterministic tests (no model credentials needed).
- `npm run lint`: Biome formatting, lint and import-boundary checks (read-only). `npm run format` applies fixes.
- `npm run ledger` / `npm run links`: validate the ledger and relative Markdown links.
- `npm run check`: everything above. Required before finishing a code change.
- `npm run sim`: long seeded simulation of the run reducer (5000 seeds; `check` runs a fixed subset).
- `npm run demo` / `npm run site`: print the example graph, or regenerate `site/trace.json`.
- `npm run fingerprint`: exact-source identity of the working tree, for ledger evidence.

## Architecture invariants

- Keep graph ownership, task dependencies and attempt history separate.
- Root depth is 0, children 1, grandchildren 2; grandchildren cannot delegate further.
- Dependencies within a graph form a DAG. Repair loops are bounded new attempts or graph
  revisions, never dependency cycles.
- One global scheduler owns runnable work. Parents waiting on children release execution
  capacity and never hold a resource their descendants need.
- Child budgets are reserved atomically from the root envelope. Children cannot broaden
  inherited permissions, scope, acceptance criteria or budgets.
- A model's success report is a proposal. Acceptance requires evidence tied to the exact
  input artifacts and code revision, including checks on the integrated tree.
- Concurrent writers get separate worktrees and integration is serial. A worktree is not a sandbox.
- Persist intent before dispatch. Use idempotency keys, attempt IDs, leases and fencing for
  recovery. Never assume an external effect runs exactly once.
- Graph revisions are immutable. Changed inputs invalidate dependent evidence.
- Cancellation propagates down and terminal outcomes propagate up; partial artifacts are kept.
- Credentials never enter task packets, artifacts or model-visible logs.

## Verification

Run `npm run check` for code changes. Add focused tests for changed graph invariants, state
transitions, contracts and failure recovery, using fake sessions. Real-provider checks must be
explicit, optional and cost-bounded. For docs-only changes, check links and consistency.
Scheduler work must test nested waits, cancellation, stale worker results, duplicate dispatch,
budget exhaustion and crash recovery. `scripts/stop-hook.sh` runs `npm run check` as a Claude Code
Stop hook when wired up in a local, untracked `.claude/settings.json`; agents without that hook
must run it themselves before handing off.

## Delegation

The main agent owns architecture and integration. Delegate independent work only with
disjoint file ownership, keep small edits local, never revert another agent's work, and
verify delegated results yourself before integrating them.

## Working together

The maintainer, Claude Code and Codex share this repository.

- **Roles.** The maintainer sets scope, approves irreversible or outward-facing actions and
  commits. The agent the maintainer starts implements; the other reviews. No agent accepts its own work.
- **One writer at a time.** Before editing, read `.agents/handoff.md` if it exists and run
  `git status`; preserve changes you did not make.
- **Handoff.** When you stop with work in progress or ask for review, overwrite
  `.agents/handoff.md` (gitignored) with: status (`in-progress`, `ready-for-review`,
  `changes-requested` or `accepted`), date, goal, files changed, checks run with exit codes,
  and open questions or risks.
- **Review.** Review the uncommitted diff against the goal in the handoff note. Report each
  finding as `file:line`, defect and evidence, and record the verdict in the handoff note.
  Do not rewrite the change unless asked.
- **Ready for review** means `npm run check` exits 0. Paste failures verbatim and name any skipped check.
