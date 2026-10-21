# Security policy

## Reporting a vulnerability

Please report security problems privately through
[GitHub's private vulnerability reporting](https://github.com/sebastianspicker/auto-pi-lot/security/advisories/new)
rather than in a public issue. Include what you found, how to reproduce it, and the commit
you tested. You should get a first response within a week.

## Scope

auto-pi-lot is an experimental local tool. It runs plans through Pi model sessions that edit
the checkout in place, runs configured check commands, and persists journals, evidence, check
logs and session transcripts under `.auto-pi-lot/`. It is meant for trusted repositories: model
sessions and checks run with the permissions of the local user, without a sandbox. Reports are
most useful for:

- leaks of provider credentials into checks, the model's shell, task packets, evidence or
  transcripts (the CLI gives checks and the model's `bash` an environment allowlist);
- the Pi session opener, the session worker and the check runner in `packages/pi` and
  `packages/worker` (tool allowlists, workspace boundaries, process cleanup);
- validation of untrusted input (plan files, configuration, journal events, model reports) in
  `packages/core` and `packages/cli`;
- the integrity of journals, evidence, ownership locks and restore points;
- the `/graph` Pi extension, the repository's CI and GitHub Pages workflows, and the
  dependencies pinned in `package-lock.json`.

The [design document](docs/design.md) describes the planned trust boundaries. A Git worktree
is not a sandbox, and the model can read any file the local user can, including Pi's own
credential store.
