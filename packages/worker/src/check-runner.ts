import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  type ArtifactStore,
  type CheckOutcome,
  type CheckProfile,
  type CheckReceipt,
  CheckReceiptSchema,
  DEFAULT_CHECK_TIMEOUT_MS,
  digest,
  identifyEvidence,
  parseDto,
  type TestCount,
} from "@auto-pi-lot/core";

/** The only environment variables a check inherits; see {@link CHECK_ENV_ALLOWLIST}. */
export const CHECK_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "USER",
  "LOGNAME",
  "SHELL",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
];

const FIXED_CHECK_ENV: Readonly<Record<string, string>> = { CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" };

export const DEFAULT_MAX_LOG_BYTES = 262_144;

/** How long after an exit or a kill the runner waits for the output streams to close. */
const CLOSE_GRACE_MS = 1000;

interface StreamLike {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

/** The part of a child process the runner uses. `ChildProcess` satisfies it. */
export interface ChildLike {
  readonly pid?: number | undefined;
  readonly stdout: StreamLike | null;
  readonly stderr: StreamLike | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit" | "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export interface SpawnOptionsLike {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly detached: boolean;
  readonly windowsHide: boolean;
  readonly stdio: ["ignore", "pipe", "pipe"];
}

/** A structural subset of `child_process.spawn`. */
export type SpawnLike = (command: string, args: readonly string[], options: SpawnOptionsLike) => ChildLike;

const defaultSpawn: SpawnLike = (command, args, options) => spawn(command, [...args], options);

export interface RunCheckInput {
  readonly workspace: string;
  readonly runId: string;
  readonly attemptId: string;
  /** The fingerprint of the tree the check runs against. */
  readonly sourceDigest: string;
  readonly artifacts: ArtifactStore;
  readonly spawn?: SpawnLike;
  /** Signals a process group (negative pid) or a process. Default: `process.kill`. */
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly clock?: () => Date;
  readonly maxLogBytes?: number;
  /** The environment the allowlist is applied to. Default: `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Aborting kills the process group; the receipt then has outcome `error` and a cancelled note. */
  readonly signal?: AbortSignal;
}

/**
 * The environment a check runs with: the allowlisted keys of `source` plus fixed CI settings.
 * Provider credentials and every other variable of the harness process never reach a repository
 * command.
 */
export function buildCheckEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHECK_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...FIXED_CHECK_ENV };
}

const CANCELLED_NOTE = "[auto-pi-lot: check cancelled]";

/**
 * The lexical check again over resolved paths, so a symbolic link inside the workspace cannot
 * point a check elsewhere. A path that does not exist cannot be resolved; it passes here and the
 * spawn fails on its own.
 */
async function reallyInside(workspace: string, candidate: string): Promise<boolean> {
  let realWorkspace: string;
  let realCandidate: string;
  try {
    realWorkspace = await realpath(workspace);
    realCandidate = await realpath(candidate);
  } catch {
    return true;
  }
  return insideWorkspace(realWorkspace, realCandidate);
}

function insideWorkspace(workspace: string, candidate: string): boolean {
  const relative = path.relative(workspace, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function lastCount(text: string, pattern: RegExp): number | null {
  let found: number | null = null;
  for (const match of text.matchAll(pattern)) found = Number(match[1]);
  return found;
}

/** Reads a node:test (`ℹ pass 3`) or TAP (`# pass 3`) summary from a log, or null when there is none. */
export function parseTestCount(log: string): TestCount | null {
  const count = (name: string): number | null => lastCount(log, new RegExp(`^(?:ℹ|#)\\s+${name}\\s+(\\d+)\\s*$`, "gm"));
  const passed = count("pass");
  const failed = count("fail");
  const skipped = count("skipped") ?? count("skip");
  if (passed === null && failed === null) return null;
  return { passed: passed ?? 0, failed: failed ?? 0, skipped: skipped ?? 0 };
}

/** Keeps the last bytes of the combined output. */
class TailBuffer {
  readonly #limit: number;
  #chunks: Buffer[] = [];
  #size = 0;
  #dropped = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(chunk: Buffer | string): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.#chunks.push(bytes);
    this.#size += bytes.length;
    for (;;) {
      const first = this.#chunks[0];
      if (first === undefined || this.#size - first.length < this.#limit) break;
      this.#chunks.shift();
      this.#size -= first.length;
      this.#dropped += first.length;
    }
    const first = this.#chunks[0];
    if (first !== undefined && this.#size > this.#limit) {
      const excess = this.#size - this.#limit;
      this.#chunks[0] = Buffer.from(first.subarray(excess));
      this.#size -= excess;
      this.#dropped += excess;
    }
  }

  toBytes(): Buffer {
    let bytes = Buffer.concat(this.#chunks);
    let dropped = this.#dropped;
    if (bytes.length > this.#limit) {
      dropped += bytes.length - this.#limit;
      bytes = bytes.subarray(bytes.length - this.#limit);
    }
    if (dropped === 0) return bytes;
    return Buffer.concat([
      Buffer.from(`[auto-pi-lot: log truncated, first ${dropped} bytes dropped]\n`, "utf8"),
      bytes,
    ]);
  }
}

interface Finished {
  readonly outcome: CheckOutcome;
  readonly exitCode: number | null;
}

/**
 * Runs one check profile in the workspace and returns its receipt. The command is one executable
 * and an argument list (no shell), run with an allowlisted environment under a timeout that kills
 * the whole process group. The outcome comes from the real exit status, never from a model.
 */
export async function runCheck(profile: CheckProfile, input: RunCheckInput): Promise<CheckReceipt> {
  const clock = input.clock ?? (() => new Date());
  const spawnChild = input.spawn ?? defaultSpawn;
  const signal = input.kill ?? ((pid: number, name: NodeJS.Signals) => process.kill(pid, name));
  const maxLogBytes = input.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
  const workspace = path.resolve(input.workspace);
  const cwd = path.resolve(workspace, profile.cwd ?? ".");
  const log = new TailBuffer(maxLogBytes);
  const startedAt = clock();

  let finished: Finished;
  // Lexically inside, and really inside once symbolic links are resolved; a missing cwd is an error.
  const confined = insideWorkspace(workspace, cwd) && (await reallyInside(workspace, cwd));
  if (!confined) {
    log.push(`[auto-pi-lot: check not run: cwd ${JSON.stringify(profile.cwd)} is outside the workspace]\n`);
    finished = { outcome: "error", exitCode: null };
  } else if (input.signal?.aborted === true) {
    log.push(`${CANCELLED_NOTE}\n`);
    finished = { outcome: "error", exitCode: null };
  } else {
    finished = await execute(profile, {
      cwd,
      env: buildCheckEnv(input.env ?? process.env),
      spawnChild,
      signal,
      log,
      ...(input.signal === undefined ? {} : { abort: input.signal }),
    });
  }

  const finishedAt = clock();
  const logBytes = log.toBytes();
  const logArtifactId = await input.artifacts.put(logBytes);
  const testCount = parseTestCount(logBytes.toString("utf8"));
  const receipt = identifyEvidence<CheckReceipt>({
    kind: "check",
    schemaVersion: 1,
    runId: input.runId,
    attemptId: input.attemptId,
    profileId: profile.id,
    profileVersion: digest(profile),
    executable: profile.command,
    args: profile.args,
    environmentDigest: digest({ platform: process.platform, arch: process.arch, node: process.version }),
    inputDigest: digest({ profileId: profile.id, sourceDigest: input.sourceDigest }),
    sourceDigest: input.sourceDigest,
    exitCode: finished.exitCode,
    outcome: finished.outcome,
    ...(testCount === null ? {} : { testCount }),
    logArtifactIds: [logArtifactId],
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  });
  const parsed = parseDto(CheckReceiptSchema, receipt);
  if (!parsed.ok) {
    throw new Error(`check receipt for ${profile.id} is invalid: ${JSON.stringify(parsed.issues)}`);
  }
  return parsed.value;
}

interface ExecuteContext {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly spawnChild: SpawnLike;
  readonly signal: (pid: number, name: NodeJS.Signals) => void;
  readonly log: TailBuffer;
  readonly abort?: AbortSignal;
}

function execute(profile: CheckProfile, context: ExecuteContext): Promise<Finished> {
  const { log } = context;
  const detached = process.platform !== "win32";
  const timeoutMs = profile.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;

  return new Promise<Finished>((resolve) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let exit: Finished | null = null;
    let timer: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;
    let groupKilled = false;

    const settle = (result: Finished): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      context.abort?.removeEventListener("abort", onAbort);
      killGroup();
      resolve(result);
    };
    const settleAfterGrace = (result: Finished): void => {
      clearTimeout(grace);
      grace = setTimeout(() => settle(result), CLOSE_GRACE_MS);
    };

    let child: ChildLike;
    try {
      child = context.spawnChild(profile.command, profile.args, {
        cwd: context.cwd,
        env: context.env,
        shell: false,
        detached,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      log.push(`[auto-pi-lot: spawn failed: ${(error as Error).message}]\n`);
      resolve({ outcome: "error", exitCode: null });
      return;
    }

    child.stdout?.on("data", (chunk) => log.push(chunk));
    child.stderr?.on("data", (chunk) => log.push(chunk));
    child.on("error", (error) => {
      log.push(`[auto-pi-lot: spawn failed: ${error.message}]\n`);
      settle({ outcome: "error", exitCode: null });
    });
    const result = (code: number | null): Finished => {
      if (cancelled) return { outcome: "error", exitCode: code };
      return timedOut
        ? { outcome: "timeout", exitCode: code }
        : { outcome: code === 0 ? "pass" : "fail", exitCode: code };
    };
    child.on("exit", (code) => {
      exit = result(code);
      // A successful parent can leave background writers behind. End their lifetime with the check.
      killGroup();
      settleAfterGrace(exit);
    });
    child.on("close", (code) => {
      settle(timedOut || cancelled ? result(code) : (exit ?? result(code)));
    });

    const killGroup = (): void => {
      if (groupKilled) return;
      groupKilled = true;
      try {
        if (detached && child.pid !== undefined) context.signal(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process is already gone.
        }
      }
    };

    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      log.push(`[auto-pi-lot: check timed out after ${timeoutMs} ms; process group killed]\n`);
      killGroup();
      settleAfterGrace({ outcome: "timeout", exitCode: null });
    }, timeoutMs);

    function onAbort(): void {
      if (settled) return;
      cancelled = true;
      log.push(`${CANCELLED_NOTE}\n`);
      killGroup();
      settleAfterGrace({ outcome: "error", exitCode: null });
    }
    context.abort?.addEventListener("abort", onAbort, { once: true });
    if (context.abort?.aborted) onAbort();
  });
}
