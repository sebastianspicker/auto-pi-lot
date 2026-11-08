import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join, relative } from "node:path";

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

/**
 * The ref of a run's restore point; dots are escaped so a run ID can never form `..` or `.lock`.
 * Escaping can push the name past the 255-byte limit of one ref component; such a name is
 * shortened the way `encodeRunId` shortens a long file name.
 */
export function restoreRefFor(runId: string): string {
  const name = encodeRunId(runId).replaceAll(".", "%2e");
  const fitted =
    name.length <= 255
      ? name
      : `${name.slice(0, 200)}%%${createHash("sha256").update(runId).digest("hex").slice(0, 16)}`;
  return `refs/auto-pi-lot/restore/${fitted}`;
}

/** The message printed after a restore point is taken; the command is limited to the workspace's own path. */
export function restoreHint(point: RestorePoint, workspace: string): string {
  const pathspec = relative(point.root, workspace) || ".";
  return `Restore point ${point.ref} (${point.commit.slice(0, 12)}). To bring ${pathspec === "." ? "the repository" : pathspec} back to it, run: git -C ${point.root} restore --source=${point.ref} --worktree -- ${pathspec}  (gitignored files are not included in the restore point; files the run creates are not removed; edits made in that path after the run started are overwritten too)`;
}

let activeIndex: string | null = null;

/** Deletes the temporary index of a restore point still being built; synchronous, for the forced-exit path. */
export function removeActiveRestoreIndex(): void {
  if (activeIndex === null) return;
  try {
    unlinkSync(activeIndex);
  } catch {
    // Already gone.
  }
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
 * Removes a restore point whose run never started, so the plan can run again under the same id.
 * Git deletes the ref only while it still points at `point.commit`.
 */
export async function discardRestorePoint(point: RestorePoint): Promise<void> {
  await required(point.root, ["update-ref", "-d", point.ref, point.commit]);
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
  const ref = restoreRefFor(runId);
  // A run id reused after its journal was removed must not replace the snapshot taken before that run's edits.
  const existing = await git(root, ["rev-parse", "--verify", "--quiet", ref]);
  if (existing.ok) {
    throw new Error(
      `Run ${runId} already has a restore point at ${ref} (${existing.stdout.trim().slice(0, 12)}). Start a new run with --run-id <new id>; delete the old point with "git update-ref -d ${ref}" only if you no longer need it.`,
    );
  }
  const index = join(gitDir, `auto-pi-lot-restore-index-${process.pid}`);
  activeIndex = index;
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
    // The empty old value makes git refuse if the ref appeared since the check above.
    await required(root, ["update-ref", ref, commit, ""]);
    const dirty = head === null || tree !== (await required(root, ["rev-parse", `${head}^{tree}`]));
    return { ref, commit, root, dirty };
  } finally {
    activeIndex = null;
    await unlink(index).catch(() => undefined); // Absent when git failed before writing it.
  }
}
