import { execFileSync } from "node:child_process";

import { snapshotWorkspace } from "../packages/worker/src/workspace.js";

/**
 * Exact-source evidence fingerprint for the working tree, as `npm run fingerprint` prints it for
 * the implementation ledger. It is the worker's workspace fingerprint (`snapshotWorkspace`: git-listed tracked and
 * untracked-but-not-ignored files, sorted, one `path\0sha256(content)` line each; a symlink as its
 * target string, a listed but missing path as `deleted`), so ledger evidence and run evidence use
 * one algorithm. The worker imports `@auto-pi-lot/core` from `dist`: run `npm run build` first.
 */
function currentCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const snapshot = await snapshotWorkspace(process.cwd());
console.log(
  JSON.stringify(
    {
      commit: currentCommit(),
      dirtyTreeFingerprint: snapshot.digest,
      fileCount: snapshot.entries.size,
    },
    null,
    2,
  ),
);
