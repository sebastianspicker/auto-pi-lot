import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import path from "node:path";

import { buildCheckEnv, isInsideRoot } from "./check-runner.js";

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
  /** Used by the default `listFiles` to ask git; only a "not a git repository" rejection selects the directory walk. */
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
    const options = {
      encoding: "utf8" as const,
      maxBuffer: 256 * 1024 * 1024,
      timeout: 60_000,
      env: buildCheckEnv(process.env),
    };
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Only "not a repository" or no git at all selects the walk: both hold for every snapshot, while
    // a refusal, overflow or timeout can be transient and must not flip the file set.
    const noGit = (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
    if (!noGit && !/not a git repository/i.test(message)) {
      throw new Error(`git could not list the workspace at ${root}: ${message}`, { cause: error });
    }
    const found: string[] = [];
    await walk(root, "", found);
    return found;
  }
}

function isRuntimeState(entry: string): boolean {
  const normalized = entry.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized === RUNTIME_STATE_DIR || normalized.startsWith(`${RUNTIME_STATE_DIR}/`);
}

/**
 * The exact-source identity of a working tree, `sha256:<hex>`: one line per listed path, sorted.
 * A file contributes `path\0sha256(content)\n`, a symlink `path\0symlink:<target>\n` (the link
 * target string, never followed) and a listed path that is gone `path\0deleted\n`. Also used by
 * scripts/source-fingerprint.ts. Paths under `.auto-pi-lot/` are dropped in both listing modes,
 * and any listed path that resolves outside `root` is skipped, so only files under the root are read.
 * With `deps.cache`, a file's hash is reused when its dev, inode, size, mtime and ctime are unchanged
 * and both times are at least 2 s older than the moment it was hashed, so a file written in the
 * same instant it was hashed is always read again. The result is identical with or without a cache.
 */
export async function fingerprintWorkspace(root: string, deps: WorkspaceDeps = {}): Promise<string> {
  return (await snapshotWorkspace(root, deps)).digest;
}

/** The fingerprint plus, per listed path, the value hashed after `\0` (content hex, `deleted` or `symlink:<target>`). */
export interface WorkspaceSnapshot {
  readonly digest: string;
  readonly entries: ReadonlyMap<string, string>;
}

/** Sorted paths whose value differs between the snapshots or that exist in only one of them. */
export function changedPaths(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] {
  const paths = new Set([...before.entries.keys(), ...after.entries.keys()]);
  return [...paths].filter((entry) => before.entries.get(entry) !== after.entries.get(entry)).sort();
}

/** Same walk and rules as `fingerprintWorkspace`, keeping the per-path values. */
export async function snapshotWorkspace(root: string, deps: WorkspaceDeps = {}): Promise<WorkspaceSnapshot> {
  const absoluteRoot = path.resolve(root);
  const list = deps.listFiles ?? ((directory: string) => listWorkspaceFiles(directory, deps.execFile));
  const kindOf = deps.lstat ?? defaultLstat;
  const hexOf = async (file: string, entry: string): Promise<string> => {
    try {
      if (deps.readFile !== undefined)
        return createHash("sha256")
          .update(await deps.readFile(file))
          .digest("hex");
      const content = createHash("sha256");
      // Streamed, so a file of any size is never held whole in memory.
      for await (const chunk of createReadStream(file)) content.update(chunk);
      return content.digest("hex");
    } catch (error) {
      throw new Error(
        `cannot read workspace file ${entry}: ${error instanceof Error ? error.message : String(error)}`,
        {
          cause: error,
        },
      );
    }
  };
  const target = deps.readlink ?? ((file: string) => readlink(file));
  const cache = deps.cache;
  const statOf = deps.stat ?? defaultStat;
  const nowNs = deps.nowNs ?? defaultNowNs;

  const entries = (await list(absoluteRoot)).filter((entry) => !isRuntimeState(entry));
  const hash = createHash("sha256");
  const values = new Map<string, string>();
  const record = (entry: string, value: string): void => {
    values.set(entry, value);
    hash.update(`${entry}\0${value}\n`);
  };
  const listed = new Set<string>();
  const nestedRoots: string[] = [];
  for (const entry of [...new Set(entries)].sort()) {
    const absolute = path.resolve(absoluteRoot, entry);
    if (!isInsideRoot(absoluteRoot, absolute, false)) continue;
    listed.add(absolute);
    if (cache !== undefined) {
      const stat = await statOf(absolute);
      if (stat !== null) {
        const cached = cache.entries.get(absolute);
        if (cached !== undefined && unchangedSince(cached, stat)) {
          record(entry, cached.hex);
          continue;
        }
        const hashedAtNs = nowNs();
        const hex = await hexOf(absolute, entry);
        cache.entries.set(absolute, { ...stat, hashedAtNs, hex });
        record(entry, hex);
        continue;
      }
      cache.entries.delete(absolute);
    }
    const kind = await kindOf(absolute);
    if (kind === "other") {
      // git lists a nested repository or submodule as one directory entry; fingerprint what is inside it.
      const isDirectory = await lstat(absolute).then(
        (stats) => stats.isDirectory(),
        () => false,
      );
      if (isDirectory) {
        const inner = { ...deps, listFiles: (directory: string) => listWorkspaceFiles(directory, deps.execFile) };
        record(entry, `nested:${(await snapshotWorkspace(absolute, inner)).digest}`);
        nestedRoots.push(absolute + path.sep);
      }
      continue;
    }
    if (kind === "missing") {
      record(entry, "deleted");
    } else if (kind === "symlink") {
      record(entry, `symlink:${await target(absolute)}`);
    } else {
      record(entry, await hexOf(absolute, entry));
    }
  }
  if (cache !== undefined) {
    // Entries of paths that left the listing would otherwise stay for the life of the cache.
    for (const key of cache.entries.keys()) {
      const inScope = key.startsWith(absoluteRoot + path.sep) && !nestedRoots.some((nested) => key.startsWith(nested));
      if (inScope && !listed.has(key)) cache.entries.delete(key);
    }
  }
  return { digest: `sha256:${hash.digest("hex")}`, entries: values };
}
