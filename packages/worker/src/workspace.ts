import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";

import { buildCheckEnv } from "./check-runner.js";

/** The harness's own runtime state; it changes during a run and is never part of the source identity. */
export const RUNTIME_STATE_DIR = ".auto-pi-lot";

const WALK_SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([".git", "node_modules", RUNTIME_STATE_DIR]);

export type FileKind = "file" | "symlink" | "missing" | "other";

export type ExecFileLike = (file: string, args: readonly string[]) => Promise<{ readonly stdout: string }>;

/** What the cache compares: nanosecond `lstat` fields of a regular file. */
export interface CacheStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface CacheEntry extends CacheStat {
  /** Wall clock (ns) taken before the content was read. */
  readonly hashedAtNs: bigint;
  readonly hex: string;
}

/** Opaque per-file content-hash cache for `fingerprintWorkspace`; create one with `createFingerprintCache`. */
export interface FingerprintCache {
  readonly entries: Map<string, CacheEntry>;
}

/** A file is only trusted when its mtime and ctime are this much older than the moment it was hashed (the racy-git rule). */
const RACY_WINDOW_NS = 2_000_000_000n;

/** Creates an empty cache. Reuse one across calls on the same workspace to skip re-hashing unchanged files. */
export function createFingerprintCache(): FingerprintCache {
  return { entries: new Map() };
}

/** Everything fingerprinting reads, injectable so tests need no real tree. */
export interface WorkspaceDeps {
  /** Relative, `/`-separated paths of the files that make up the tree. */
  listFiles?: (root: string) => Promise<string[]>;
  /** Used by the default `listFiles` to ask git; a rejection selects the directory walk. */
  execFile?: ExecFileLike;
  /** Must not follow symlinks. `other` (a directory, a socket) is skipped. */
  lstat?: (absolutePath: string) => Promise<FileKind>;
  readFile?: (absolutePath: string) => Promise<Uint8Array>;
  readlink?: (absolutePath: string) => Promise<string>;
  /** Reuses content hashes of files that provably have not changed; without it every file is read. */
  cache?: FingerprintCache;
  /** Nanosecond `lstat` of a regular file for the cache; `null` when it is missing or not a regular file. */
  stat?: (absolutePath: string) => Promise<CacheStat | null>;
  /** Wall clock in nanoseconds, taken before a file is read; injectable so the racy rule needs no sleeping. */
  nowNs?: () => bigint;
}

/** git runs with the same allowlisted environment as a check, so no provider credential reaches it. */
const defaultExecFile: ExecFileLike = (file, args) =>
  new Promise((resolve, reject) => {
    const options = { encoding: "utf8" as const, maxBuffer: 256 * 1024 * 1024, env: buildCheckEnv(process.env) };
    execFile(file, [...args], options, (error, stdout) => {
      if (error !== null) reject(error);
      else resolve({ stdout });
    });
  });

async function defaultLstat(absolutePath: string): Promise<FileKind> {
  try {
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) return "symlink";
    return stats.isFile() ? "file" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function defaultStat(absolutePath: string): Promise<CacheStat | null> {
  try {
    const stats = await lstat(absolutePath, { bigint: true });
    if (!stats.isFile()) return null;
    return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const defaultNowNs = (): bigint => BigInt(Date.now()) * 1_000_000n;

function unchangedSince(entry: CacheEntry, stat: CacheStat): boolean {
  return (
    entry.dev === stat.dev &&
    entry.ino === stat.ino &&
    entry.size === stat.size &&
    entry.mtimeNs === stat.mtimeNs &&
    entry.ctimeNs === stat.ctimeNs &&
    entry.hashedAtNs - stat.mtimeNs >= RACY_WINDOW_NS &&
    entry.hashedAtNs - stat.ctimeNs >= RACY_WINDOW_NS
  );
}

async function walk(root: string, relative: string, found: string[]): Promise<void> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!WALK_SKIPPED_DIRECTORIES.has(entry.name)) await walk(root, entryPath, found);
    } else {
      found.push(entryPath);
    }
  }
}

/** Lists the tree with git when `root` is a repository, else by walking it. */
export async function listWorkspaceFiles(root: string, run: ExecFileLike = defaultExecFile): Promise<string[]> {
  try {
    // `core.fsmonitor` could name a program in a repository config a writer edited; never start it.
    const { stdout } = await run("git", [
      "-C",
      root,
      "-c",
      "core.fsmonitor=false",
      "ls-files",
      "-z",
      "-co",
      "--exclude-standard",
    ]);
    return stdout.split("\0").filter((entry) => entry.length > 0);
  } catch {
    const found: string[] = [];
    await walk(root, "", found);
    return found;
  }
}

function insideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isRuntimeState(entry: string): boolean {
  const normalized = entry.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized === RUNTIME_STATE_DIR || normalized.startsWith(`${RUNTIME_STATE_DIR}/`);
}

/**
 * The exact-source identity of a working tree, `sha256:<hex>`: one line per listed path, sorted.
 * A file contributes `path\0sha256(content)\n`, a symlink `path\0symlink:<target>\n` (the link
 * target string, never followed) and a listed path that is gone `path\0deleted\n`. Mirrors
 * scripts/source-fingerprint.ts. Paths under `.auto-pi-lot/` are dropped in both listing modes,
 * and any listed path that resolves outside `root` is skipped, so only files under the root are read.
 * With `deps.cache`, a file's hash is reused when its dev, inode, size, mtime and ctime are unchanged
 * and both times are at least 2 s older than the moment it was hashed, so a file written in the
 * same instant it was hashed is always read again. The result is identical with or without a cache.
 */
export async function fingerprintWorkspace(root: string, deps: WorkspaceDeps = {}): Promise<string> {
  const absoluteRoot = path.resolve(root);
  const list = deps.listFiles ?? ((directory: string) => listWorkspaceFiles(directory, deps.execFile));
  const kindOf = deps.lstat ?? defaultLstat;
  const read = deps.readFile ?? ((file: string) => readFile(file));
  const target = deps.readlink ?? ((file: string) => readlink(file));
  const cache = deps.cache;
  const statOf = deps.stat ?? defaultStat;
  const nowNs = deps.nowNs ?? defaultNowNs;

  const entries = (await list(absoluteRoot)).filter((entry) => !isRuntimeState(entry));
  const hash = createHash("sha256");
  for (const entry of [...new Set(entries)].sort()) {
    const absolute = path.resolve(absoluteRoot, entry);
    if (!insideRoot(absoluteRoot, absolute)) continue;
    if (cache !== undefined) {
      const stat = await statOf(absolute);
      if (stat !== null) {
        const cached = cache.entries.get(absolute);
        if (cached !== undefined && unchangedSince(cached, stat)) {
          hash.update(`${entry}\0${cached.hex}\n`);
          continue;
        }
        const hashedAtNs = nowNs();
        const hex = createHash("sha256")
          .update(await read(absolute))
          .digest("hex");
        cache.entries.set(absolute, { ...stat, hashedAtNs, hex });
        hash.update(`${entry}\0${hex}\n`);
        continue;
      }
      cache.entries.delete(absolute);
    }
    const kind = await kindOf(absolute);
    if (kind === "other") continue;
    if (kind === "missing") {
      hash.update(`${entry}\0deleted\n`);
    } else if (kind === "symlink") {
      hash.update(`${entry}\0symlink:${await target(absolute)}\n`);
    } else {
      const content = await read(absolute);
      hash.update(`${entry}\0${createHash("sha256").update(content).digest("hex")}\n`);
    }
  }
  return `sha256:${hash.digest("hex")}`;
}
