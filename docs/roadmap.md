# Implementation roadmap

Plan revision 3, 2026-09-24.

**In short.** auto-pi-lot is built in seven milestones, M0 to M6, made up of numbered *work
packages* (AP-00 to AP-27). Only the starting scaffold (AP-00) is finished. In progress:
AP-01 (contracts), AP-26 (the reducer), AP-27 (repository gates), AP-07 (the host; decision
0008) and, since 8 October 2026, first increments of AP-08 (an in-process session worker,
decision 0012), AP-09 (a closed Pi session opener), AP-11 (configured checks run by the host,
workspace fingerprints, one workspace with serialised writers; decision 0011) and AP-12 (check
and review receipts and an evidence-based acceptance gate; decision 0010). With these, a plan
runs on a real repository with real Pi sessions from the command line. The evidence recorded
for the first three predates a restructuring of the code and has to be reviewed again before
their status can change. Everything else is not started, and none of the 41 acceptance
scenarios is formally verified yet. [Roadmap: header, table]

*About this page.* It is a plain-language edition of the roadmap for engineers and
engineering leads who want to know where the project stands and what comes next. Bracketed
references such as [Roadmap: table] point to the section of the original document this
edition was rewritten from; the originals are in the Git history at commit `bf04bd0`. Terms in
*italics* on first use are defined in the [glossary](#glossary).

## Where the details live

This page only gives an overview. The authoritative sources are:

- the [design document](design.md), which specifies the finished product;
- the [acceptance scenarios](acceptance-matrix.md), 41 numbered situations (AT-01 to AT-41)
  the finished system must be shown to handle. [Roadmap: intro]

## Recent change: three packages instead of seven

In plan revision 3 the code was reorganised into three packages, as recorded in
decision 0004: the former `contracts` and `engine`
packages were merged into `core`, and the former `pi-adapter` and `pi-extension` packages
were merged into `pi`. The [architecture page](architecture.md) describes the result. This is
why the evidence for AP-01, AP-26 and AP-27 needs a fresh review: it describes the code
before the reorganisation. [Roadmap: header, last paragraph]

## Milestones

| Milestone | Work packages | Done when |
| --- | --- | --- |
| M0: Scaffold | AP-00 | Historical: the original 11-test foundation and a demo that only prints a plan. Nothing runs. |
| M1: Durable foundation | AP-01 to AP-07, AP-26, AP-27 | Versioned data formats, full plan checking, frozen permissions and policy, a chosen SQLite storage approach, an event log with stored artifacts and budget accounting, and a plan of several tasks that runs one after another with *fake workers* and survives a restart. |
| M2: Flat coding product | AP-08 to AP-15 | Controlled worker processes, a sealed connection to Pi, automatic planning, protection of the user's uncommitted changes, trusted checks, merging results one at a time, a supervisor that recovers after a crash, and a graph-mode interface. "Flat" means no task starts its own sub-plan yet. |
| M3: Early live baseline | AP-16 | A small, approved set of real tasks measured against a single ordinary Pi session, with stated limits and the failures actually observed. |
| M4: Complete recursive execution | AP-17 to AP-21 | Bounded repair loops and plan revisions, tasks that start sub-plans (*child graphs*), parents pausing while children run, sub-sub-plans (*grandchildren*), cancellation across all levels, and recovery from failures at the boundary between levels. |
| M5: Context and operations | AP-22, AP-23 | Shrinking what a model is shown without losing what it must see, searchable run inspection, retention and restore, and exporting the evidence for a run. |
| M6: Qualification | AP-25, then AP-24 | First, evidence that the package installs and runs on each supported platform; then a full evaluation of the recursive product on real tasks under a plan fixed in advance. |

[Roadmap: milestone table]

The milestone numbers describe the overall shape, not a strict order: the real dependencies
between work packages are fixed by the design, and a package does not wait for the previous
milestone unless it depends on something in it. [Roadmap: "Start with AP-01"]

## What comes next

The first increment of **AP-01: versioned identities and execution/acceptance contracts**
exists: it separates a worker's *proposed* result from the host's *acceptance* of it, gives
every record a versioned identity, and defines how a task can depend on a result that is not
yet accepted. The reducer (AP-26), the host (AP-07), the evidence gate (AP-12), the check
runner (AP-11) and the session worker (AP-08, AP-09) run on those contracts, and the
command-line tool composes them into a usable product. The host is ahead of its planned
prerequisites: it uses interim file stores instead of the AP-04 storage decision, an
in-process worker instead of AP-08's worker processes, and one workspace instead of AP-11's
worktrees. The next steps are the early live baseline (AP-16, now runnable but not yet
authorised or measured), AP-06 (run-wide budgets), AP-03 (frozen permissions and role
policy), AP-04 (the storage decision) and worktrees with serial integration (AP-11, AP-13).

## Gates that depend on real model use

- **AP-16, the early live baseline**, needs a working bounded flat path and explicit
  authorisation to spend money on a model provider. Missing credentials or authorisation hold
  up only this measurement; they do not block the offline engineering work. [Roadmap:
  AP-16 paragraph]
- Before any live model call, the system must check each final request before it is sent
  (*final-payload admission*) and account for its cost. More advanced ways of reducing what
  a model is shown come after the basic path works. [Roadmap: AP-16 paragraph]

## What a release requires

- A **local experimental release** needs the offline and runtime packages plus AP-25 evidence
  (installation and platform checks) on each platform it claims to support.
- Calling the product **effective** additionally needs AP-16 and AP-24, the two measurements
  on real tasks.
- Neither documentation nor tests from the predecessor project count as evidence for these
  gates. Each package has a current status; no acceptance scenario is
  fully verified. [Roadmap: release paragraph]

## History

A [foundation-hardening proposal](archive/2026-09-24-foundation-hardening.md) suggested
building the pure decision logic before storage (AP-26) and adding automatic repository
checks (AP-27); both have been included since plan revision 2. Plan revision 3 then
reorganised the seven original scaffold packages into three, `core`, `pi` and `cli`, per
decision 0004; see [architecture](architecture.md).
[Roadmap: last paragraph]

## Limitations of this overview

- Status here is a snapshot of plan revision 3 (2026-09-24), updated for the host on
  2026-10-05. The design document is authoritative if the two disagree.
- The design document (§13) describes AP-01 to AP-25 as unimplemented work, while this page
  lists AP-01 as in progress. Both are true: work has started but
  nothing in AP-01 is complete. [Design §13; Roadmap: header]
- The descriptions of later milestones are plans, not commitments to dates; the sources give
  no dates.

## Glossary

| Term | Meaning here |
| --- | --- |
| Acceptance scenario (AT-xx) | One of 41 numbered situations the finished system must be shown to handle, with the kind of evidence required. |
| Artifact | A stored file produced during a run, such as a patch or a check log, identified by a hash of its content. |
| Child graph, grandchild | A sub-plan started by a task (child), and a sub-plan started by a task inside that (grandchild). Grandchildren cannot start further sub-plans. |
| Fake worker | A stand-in for a model-driven worker that returns scripted results, so the system can be tested without model calls. |
| Final-payload admission | Checking the exact request that will be sent to a model provider, including its size and cost limits, before sending it. |
| Flat | A plan in which no task starts a sub-plan. |
| Live | Involving real calls to a paid model provider. |
| SQLite | A small database stored in a single local file. |
| Work package (AP-xx) | One numbered unit of planned work with its own deliverables and evidence. |
