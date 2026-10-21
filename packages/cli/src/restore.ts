import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { encodeRunId } from "@auto-pi-lot/host";

import { git } from "./git.js";
import { RUNTIME_DIR } from "./paths.js";

/** A snapshot of the repository's working tree taken before a Pi run edits it. */
export interface RestorePoint {
  /** Where the snapshot commit is kept, so `git gc` keeps it. */
  readonly ref: string;
  readonly commit: string;
  /** The repository's top-level directory: restore commands run there. */
  readonly root: string;
  /** Whether the tree differed from HEAD (uncommitted changes or untracked files). */
  readonly dirty: boolean;
}

/** The ref of a run's restore point; dots are escaped so a run ID can never form `..` or `.lock`. */
export function restoreRefFor(runId: string): string {
  return `refs/auto-pi-lot/restore/${encodeRunId(runId).replaceAll(".", "%2e")}`;
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "auto-pi-lot",
  GIT_AUTHOR_EMAIL: "auto-pi-lot@localhost",
  GIT_COMMITTER_NAME: "auto-pi-lot",
  GIT_COMMITTER_EMAIL: "auto-pi-lot@localhost",
};

/** Runtime state (locks, journals, evidence, transcripts) at any depth is never part of a snapshot. */
const EXCLUDE_RUNTIME = `:(exclude,glob)**/${RUNTIME_DIR}/**`;

async function required(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const result = await git(cwd, args, env);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/**
 * Records the files of the repository containing `workspace` (tracked files as they are now,
 * plus untracked files that are not ignored, but not `.auto-pi-lot/`) as a commit whose parent is
 * HEAD, under `restoreRefFor(runId)`. Submodules are recorded as their commit, not their files.
 * It goes through a temporary index inside the git directory, so HEAD, the real index and the
 * working tree are left alone and no hook runs. It never restores anything itself.
 */
export async function createRestorePoint(workspace: string, runId: string): Promise<RestorePoint> {
  const root = await required(workspace, ["rev-parse", "--show-toplevel"]);
  const gitDir = await required(root, ["rev-parse", "--absolute-git-dir"]);
  const headResult = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const head = headResult.ok ? headResult.stdout.trim() : null;
  const index = join(gitDir, `auto-pi-lot-restore-index-${process.pid}`);
  try {
    const env = { GIT_INDEX_FILE: index };
    // Start from HEAD so tracked files that also match an ignore pattern stay in the snapshot.
    if (head !== null) await required(root, ["read-tree", head], env);
    await required(root, ["add", "--all", "--", ".", EXCLUDE_RUNTIME], env);
    const tree = await required(root, ["write-tree"], env);
    const commit = await required(
      root,
      ["commit-tree", tree, ...(head === null ? [] : ["-p", head]), "-m", `auto-pi-lot restore point for run ${runId}`],
      IDENTITY,
    );
    const ref = restoreRefFor(runId);
    await required(root, ["update-ref", ref, commit]);
    const dirty = head === null || tree !== (await required(root, ["rev-parse", `${head}^{tree}`]));
    return { ref, commit, root, dirty };
  } finally {
    await unlink(index).catch(() => undefined); // Absent when git failed before writing it.
  }
}
