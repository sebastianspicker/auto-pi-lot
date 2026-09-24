# Security policy

## Reporting a vulnerability

Please report security problems privately through
[GitHub's private vulnerability reporting](https://github.com/sebastianspicker/auto-pi-lot/security/advisories/new)
rather than in a public issue. Include what you found, how to reproduce it, and the commit
you tested. You should get a first response within a week.

## Scope

auto-pi-lot is early-stage and runs locally. It does not yet execute tasks, persist state or
call models on its own. Reports are most useful for:

- the Pi extension and session adapter in `packages/pi`;
- validation of untrusted input (graph specs, journal events) in `packages/core`;
- the repository's CI and GitHub Pages workflows;
- dependencies pinned in `package-lock.json`.

The [design document](docs/design.md) describes the planned trust boundaries. Note that a
Git worktree is not a sandbox: once worker execution exists, it runs with the permissions of
the local user.
