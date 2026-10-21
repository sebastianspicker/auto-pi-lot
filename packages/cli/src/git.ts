import { execFile } from "node:child_process";

import { buildCheckEnv } from "@auto-pi-lot/worker";

export interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs git in `cwd` without a shell, under the check environment allowlist (no provider
 * credentials) plus `extraEnv`, with `core.fsmonitor` off so a repository config cannot start a
 * program. Never rejects: a missing git or a failing command is `ok: false`.
 */
export function git(cwd: string, args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    const options = {
      cwd,
      encoding: "utf8" as const,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...buildCheckEnv(process.env), ...extraEnv },
    };
    execFile("git", ["-c", "core.fsmonitor=false", ...args], options, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout, stderr });
    });
  });
}

/** Whether `dir` is inside a git working tree. */
export async function isGitWorkTree(dir: string): Promise<boolean> {
  const result = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout.trim() === "true";
}
