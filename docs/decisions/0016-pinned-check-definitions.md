# 0016 — Check scripts are pinned per run, and reviewers see which files changed

Implemented 2026-11-01. Amends [0010](0010-evidence-based-acceptance.md) (what a passing check
receipt proves) and [0014](0014-recorded-execution-and-final-verification.md) (the execution
manifest).

## Context

A check profile pins a command line, not what that command line runs. `init` generates
`npm run <script>` profiles, and `npm` runs whatever `package.json` says at that moment. An
implementer may edit any file, so it could change `"test"` to skip a failing test. The check
then passes, the gate accepts, and the final verification re-runs the same weakened script.
The default reviewer has read-only tools and was never told which files changed, so it could
only find such an edit by chance. The producer's evidence was therefore partly under the
producer's control.

## Decision

1. **Pinned check definitions.** When a new Pi run is admitted, the CLI records a
   `definitionDigest` in the execution manifest for every check profile whose command is `npm`,
   whatever its arguments. It is the digest of the whole `scripts` and `config` blocks of the
   nearest `package.json` at or above the profile's directory (npm walks up to it; a script may
   call other scripts or read `$npm_package_config_*`), and of every `.npmrc` from that
   directory up to the workspace root (`script-shell` or `ignore-scripts` there would change
   every `npm run`). Dependencies and other fields are left out, so a task may still add a
   package. Other commands get no digest.
2. Before it starts a pinned check, the check runner recomputes the digest. If it differs, or
   cannot be computed, the check is not run: the receipt has outcome `error` and its log says
   the scripts or config changed since the run started. Attempt checks and the final
   verification both go through the runner, so one guard covers both. The repair packet shows
   that log, so the next attempt learns why.
3. **Changed paths.** The session worker snapshots the workspace before the first attempt of a
   run and after every attempt. A proposal records the paths changed since that first snapshot
   (`changedPaths`, at most 500; package manifests, `.npmrc` and test files first, so padding
   files cannot push them out; a limitation notes any that were cut). A checker's task packet
   lists them, so a reviewer can read changed tests and scripts, including edits an earlier,
   rejected attempt left behind.
4. The pin is taken once per run, not per attempt: an attempt that weakened a script and was
   rejected cannot make the weakened script the baseline of the next attempt.

## Consequences

- `definitionDigest` and `changedPaths` are optional. Journals and evidence written before this
  change still replay and load; their checks are simply not pinned.
- A task that changes any `package.json` script or `config` entry, or an `.npmrc`, fails its
  `npm` checks for the rest of the run. To change a check script on purpose, the operator edits
  it and starts a new run.
- Test files themselves are not frozen. They are disclosed to the reviewer, not protected.
- The changed-path baseline lives in the worker process: after a resume it is the tree at the
  first attempt after the resume.
- Not covered, because the harness is still not a sandbox (0012): `yarn`, `pnpm`, `make` or
  direct commands; npm flags such as `--prefix` or `--workspace` that point at another
  package; the user-level `~/.npmrc`; gitignored files such as `node_modules/.bin`, which
  `npm run` puts on `PATH` and which are also outside the fingerprint; and a background process
  the model started that rewrites a script between the digest check and the spawn.
