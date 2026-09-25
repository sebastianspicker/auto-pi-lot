# Rewrite report: plain-language editions of the core documents

Date: 2026-09-25. Editor: Claude Code, at the maintainer's request. The originals are in the
Git history at commit `bf04bd0` (branch `redesign/trace-viewer`); the rewritten editions
replaced them in place, as the maintainer asked after work had started. The changes are
uncommitted.

## Files

| Source (original at `bf04bd0`) | Rewritten file | Words before → after |
| --- | --- | --- |
| `README.md` | [README.md](../README.md) | 783 → 1,624 |
| `docs/architecture.md` | [architecture.md](architecture.md) | 921 → 1,850 |
| `docs/design.md` | [design.md](design.md) | 4,468 → 7,221 |
| `docs/roadmap.md` | [roadmap.md](roadmap.md) | 449 → 1,257 |
| `docs/acceptance-matrix.md` | [acceptance-matrix.md](acceptance-matrix.md) | 2,345 → 3,655 |

Context only, not rewritten: `docs/implementation-ledger.json` (task titles, statuses, status
vocabulary), `docs/decisions/0001-engine-pure-reducer.md`, `AGENTS.md`. Every source file was
read in full; none was unreadable. No format conversion was needed (all Markdown).

## 1. Source analysis

**The set.** Five Markdown documents from an early-stage open-source TypeScript project that
orchestrates AI coding agents. They form a hierarchy: the README is the public entry point;
architecture describes the code that exists; design specifies the target product; the roadmap
orients progress against a machine-readable ledger; the acceptance matrix defines how "done"
will be verified. All five are written for insiders: dense with distributed-systems terms
(fencing, idempotency, leases, WAL, compare-and-swap), work-package codes and code identifiers.

| Document | Type | Core message | Strength of evidence |
| --- | --- | --- | --- |
| README | Project overview | Graph mode for Pi: models propose, deterministic code decides; only the core is built. | Status claims are factual and verifiable (tests, viewer). Benefits are design intent. |
| Architecture | Current-state technical description | Three packages; a pure reducer decides, nothing acts yet; boundaries are linter-enforced. | Describes existing, tested code. |
| Design | Target specification | Full behaviour of the finished system: contracts, state machines, budget lifecycle, storage, recovery, nesting. | Almost entirely unimplemented requirements; defaults are "suggested". |
| Roadmap | Status overview | Milestones M0–M6; AP-00 done, AP-01/26/27 in progress with evidence needing re-review; start with AP-01. | Snapshot of plan revision 3; defers to the ledger. |
| Acceptance matrix | Verification plan | 41 scenarios with triggers, observable assertions, evidence classes; none verified. | Explicitly "proposed"; no results. |

**Key numbers and what they mean.** Node.js ≥ 22.19; 3 packages; 3 scripted trace scenarios;
depth limit 2; suggested defaults of 4 active sessions, 24 lifetime tasks, 2 repair rounds, 2
re-plans (suggested, not enforced); 41 acceptance scenarios, 0 verified; work packages AP-00 to
AP-27; 7 milestones M0–M6; the predecessor's 19 migrations do not carry over; M0's historical
11-test foundation; the invariant `spent + outstanding reservations <= authorized limit`.

**Stated limitations.** No persistence, workers, supervisor or model calls exist; `/graph` is a
placeholder; live effectiveness is unmeasured; worktrees are not sandboxes; hard budget caps are
qualified by enforced dimensions; mock providers cannot prove live behaviour.

**Conflicts and inconsistencies found.**

1. Design §5 says "The scaffold currently unlocks every edge only on `accepted`." Architecture
   and README say the current reducer supports both `result_ready` and `accepted`. The design
   sentence is out of date. *Handled:* kept, and flagged in a note in design §5.
2. Design §13 says AP-01 to AP-25 "describe unimplemented work"; the roadmap and ledger list
   AP-01 as in progress. Compatible in the ledger's vocabulary (started ≠ implemented), but
   confusing. *Handled:* explained in roadmap "Limitations" and a note in design §13.
3. Design §14's release conditions list AP-01–AP-15, AP-17–AP-23 and AP-25, but not AP-26 or
   AP-27, which the roadmap places in M1. *Handled:* flagged in design "Limitations"; not
   resolved.
4. The README on this branch differs from `main` by one sentence (the viewer's "journal"
   replacing "timeline"), from the concurrent viewer redesign. The rewrite follows the branch.

**Audience signals.** GitHub-facing README with badges and a screenshot tour; "for a GitHub
audience" in the commit that introduced these docs; CONTRIBUTING.md for human contributors;
AGENTS.md sends coding agents to the same files; vocabulary assumes distributed-systems
knowledge; no funder or non-technical stakeholder is named.

## 2. Resolved brief

The user brief was empty; source documents were confirmed by the maintainer as the five core
documents. The maintainer later asked for the originals to be replaced.

| Field | Value | Origin |
| --- | --- | --- |
| Mode | per_document | Default |
| Output location | Overwrite in place (originals preserved in Git at `bf04bd0`) | Provided by user (mid-task) |
| Audience | Software engineers and engineering leads who use AI coding agents and evaluate or follow this project, but do not know its internals or distributed-systems vocabulary | Inferred (high): the docs are GitHub-facing and the project is pre-release, so evaluators outnumber implementers; the originals already serve core implementers, so rewriting for them would change little |
| Runner-up audience | New contributors who will implement work packages | Inferred |
| Prior knowledge | Git, TypeScript/Node.js, CI, what an AI coding agent is; not fencing, idempotency, leases, WAL, CAS or the AP/AT codes | Inferred (medium) |
| Purpose | Understand what exists, what is promised and how it will be verified, well enough to decide whether to follow, adopt or contribute | Default, adapted |
| Reading context | GitHub web view, desktop; the README also on the npm or GitHub landing page | Inferred (medium) |
| Likely concerns | "Does it work yet?", "Is this hype?", "Is my code safe?", "What does it cost?", "How will they know it works?" | Inferred (medium) |
| Format | Same genre and file per document; plain-language summary first, adapted content, limitations, glossary | Default |
| Length | Full scope; no findings, requirements or scenarios dropped | Default |
| Tone | Clear, neutral, precise; no marketing | Default, matched to sources |
| Language | English (sources and user prompt) | Default |

## 3. Audience plan

**What this audience most needs.**

1. It does not run real tasks yet; only the deterministic core exists and is tested.
2. The central rule: a model's report is a proposal; the host accepts only with evidence.
3. How trust is enforced mechanically: typed rejections, fencing tokens, `result_ready` versus
   `accepted` dependencies.
4. One budget, one scheduler and bounded nesting (depth 2), and why "unknown" is not "zero".
5. Safety of their own code: uncommitted work is protected, results come as a branch or patch
   plus evidence, and worktrees are not sandboxes.
6. What "done" means: 41 observable scenarios, evidence kinds, and no pass mark for live
   effectiveness.
7. Where to look next, and that the ledger is authoritative.

**Likely questions and objections.** Can I use it today? (No; see the README status.) Does it
call paid models? (Nothing today; live runs need separate authorisation.) Will it touch my
checkout? (Not silently; design §9.) How is this different from running Pi directly? (Unmeasured;
AP-16/AP-24.) Is it sandboxed? (No; design §9.)

**Jargon plan (used consistently across all five files).**

| Source term | Plain term used, with the original kept where code depends on it |
| --- | --- |
| host / harness | *harness* = auto-pi-lot as a whole; *host* = the non-AI program that drives decisions and carries them out |
| reducer, `decide` | "the decision function (the reducer)" |
| journal / journal event | "event log" / "event", term kept and defined |
| `result_ready` / `accepted` edge | "needs a result" / "needs an accepted result" (matches the trace viewer's legend) |
| fencing token | "a number that goes up with every new attempt; old numbers are rejected" |
| lease | "time-limited claim of ownership" |
| idempotency key | "request key that makes repeating a request safe" |
| root account / allowance | "root budget" |
| reservation, dispatch intent, settled, uncertain, reconciled | kept, with the state machine also explained in words |
| receipt | "saved record of an executed check" |
| worktree | "separate Git working copy (not a sandbox)" |
| DAG / cycle | "no circular dependencies" |
| AP-xx / AT-xx | "work package" / "acceptance scenario", codes kept |
| WAL, CAS, IPC, SDK, canary | defined in glossaries |

**Deliberately left out.** Nothing substantive. Code identifiers, file paths, Biome rule names
and contract names were kept (in code font) because contributors and coding agents rely on
them; plain explanations were added beside them rather than replacing them.

## 4. Outlines and section mapping

Every edition adds: an "In short" summary, an "About this page" note (audience, citation
convention, where the originals are), "Limitations" and "Glossary". The bracketed citations
refer to the originals at `bf04bd0`.

- **README.** Source sections: intro → "In short" and "Why this exists"; Status → status box;
  viewer link → "In short"; Tour (3 subsections) → "See it working" (same 3 subsections,
  images kept); Quick start → "Try it yourself" (commands verbatim); How it works (4 bullets)
  → "How it works, in four ideas"; Repository layout → "What is in the repository"; Documentation
  → "Further reading"; Contributing, License → "Contributing and license".
- **Architecture.** What runs today → same; Packages (table and diagram) → same, diagram
  verbatim; Enforcement → "How the rules are enforced"; The reducer protocol → "How the host
  uses the reducer" (numbered steps kept); State → same; Where new code goes → same; Repository
  tooling → same.
- **Design.** Intro → "In short" plus a new "The design at a glance" (a summary; every bullet
  cites its section); Background (with the 9-row lessons table) → same; Conventions → same;
  §1–§14 → §1–§14 with the same numbers and headings made plainer; §5 gets a flagged note on the
  out-of-date sentence; §7's state machine is kept verbatim and explained in words.
- **Roadmap.** Header → "In short" and "Recent change"; intro links → "Where the details live";
  milestone table → same (exit conditions in plain words); Start with AP-01 → "What comes next";
  AP-16 paragraph → "Gates that depend on real model use"; release paragraph → "What a release
  requires"; foundation-hardening paragraph → "History".
- **Acceptance matrix.** Status and intro → "In short" and "What this page is, and is not";
  evidence classes → "Kinds of evidence"; receipt contract → "What every test record must
  contain"; fault-injection paragraph → its own subsection; six scenario tables → six tables
  with all 41 IDs, triggers, assertions and evidence classes; closing paragraph → "How status
  is recorded".

## 5. Verification log

Checks applied to every file: numbers against the source; hedges ("suggested", "proposed",
"not yet", "may", "should") kept; no added causal claims; every source section mapped (see
§4); every technical term defined in text or in the glossary; the same plain terms across files;
links checked with `npm run links` (passed: 22 Markdown files, including this report); each
file reopened after writing (word counts above; last line is the final glossary row; 41 `AT-`
rows present; design §1–§14 headings present).

- **README.** Removed an unsourced sentence from the first draft (that agents "may report all
  tests pass when they do not"), replaced by a sourced framing. Added sources for "protects
  against a stale worker overwriting its replacement" (Design §10, AT-19) and for "unknown is
  not zero" (Design §7). Commands, Node version and image paths match the source.
- **Architecture.** Rejection reasons, event names, file paths and all 5 enforcement rules
  checked against the source. The glossary definition of graph revision ("never edited, only
  superseded") comes from design §11 and AGENTS.md, not architecture.
- **Design.** Numbers checked: depth 2; 4, 24, 2, 2 defaults (kept as "suggested"); 19
  migrations; the budget invariant and state machine verbatim. All 15 contracts and all 6 roles
  are present. The "at a glance" bullets are summaries, each citing its section. Two conflicts
  flagged (§5, §13) and one gap (§14).
- **Roadmap.** Milestone contents checked against the source and ledger titles; M0's "11-test"
  kept as historical. "AP-02 (complete plan checking), AP-03 (frozen permissions and role
  policy), AP-04 (storage decision)" come from ledger titles.
- **Acceptance matrix.** All 41 scenarios re-read against the source row by row; evidence
  classes unchanged; the status vocabulary (6 states) kept. The limitation "several scenarios
  depend on the storage decision" is an editorial inference, cited to design §8.

## 6. Editor's notes

**Key assumptions.**

- *Audience is evaluators, not implementers (high).* If contributors are the main readers, the
  added explanations are overhead but nothing they need was removed: identifiers, paths, rule
  names and contract names are all still there.
- *Replacing the originals is safe for coding agents (medium).* AGENTS.md tells agents to read
  `docs/architecture.md` and "the design section you touch". Those sections still exist with
  the same numbers and identifiers, but the prose is longer. If agents or the maintainer prefer
  the terse originals, restore them with `git checkout bf04bd0 -- README.md docs/`.
- *Citations to the originals at `bf04bd0` stay meaningful (medium).* If that commit is
  squashed or rebased away, the bracketed references lose their target; update the commit
  reference in each "About this page" note.

**How editions for the runner-up (new contributors) would differ.** Shorter explanations; the
glossaries would be replaced by links to the code; each design section would link its ledger
work package and the relevant `core` module; the README tour would give way to a "first
contribution" path.

**Omitted source content.** None. The README's badges, images and commands were kept verbatim.

**Simplifications that lose nuance.**

- "Needs a result" for `result_ready` hides that a *rejected* result does not satisfy it; the
  trace viewer and reducer treat that case precisely.
- "Fencing token" as "a number that goes up per attempt" omits that fencing also covers leases
  and settlement of costs (kept in AT-19 and design §10).
- Design §7's "qualified request protocol" is kept as a phrase; the sources do not define
  "qualified" further.
- The definition of WAL mode is general SQLite knowledge added for readers, not a claim from
  the sources.

**Open questions and conflicts in the sources** (see §1): the out-of-date sentence in design §5;
the "unimplemented" versus "in progress" wording in design §13; the absence of AP-26 and AP-27
from design §14's release conditions.

**For a subject-matter expert to double-check.**

- The plain rendering of AT-11 and design §7 (releasing a reservation after a crash), the most
  intricate rule in the set.
- Whether "held back, to be on the safe side" (AT-12) correctly renders "conservatively held".
- Whether §6's "semantic repair" gloss ("fixing a wrong result, as opposed to a malformed one")
  matches the intended distinction from "schema repair".
- The glossary entries for canary, compare-and-swap and WAL mode.
