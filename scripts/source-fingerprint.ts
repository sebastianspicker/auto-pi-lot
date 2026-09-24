import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";

function sha256Hex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function currentCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function trackedAndUntrackedFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { encoding: "utf8" });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}

/**
 * Injected filesystem reader for {@link computeSourceFingerprint}, so fingerprinting is
 * testable without touching the real filesystem. `lstat` must not follow symlinks.
 */
export interface SourceFileSystem {
  lstat(path: string): "file" | "symlink" | "missing";
  readFile(path: string): Uint8Array;
  readlink(path: string): string;
}

function realLstat(path: string): "file" | "symlink" | "missing" {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  return stats.isSymbolicLink() ? "symlink" : "file";
}

const realFileSystem: SourceFileSystem = {
  lstat: realLstat,
  readFile: (path) => readFileSync(path),
  readlink: (path) => readlinkSync(path),
};

/**
 * Exact-source evidence fingerprint for an uncommitted or dirty working tree: a SHA-256
 * over one line per path (sorted) for every git-tracked-or-untracked-but-not-ignored
 * file. A present file contributes `path\0sha256(content)\n`; a symlink contributes
 * `path\0symlink:<target>\n` hashing the link target string itself (git's blob content
 * for mode 120000), never the content the link resolves to; a path listed by git but
 * no longer present on disk (deleted but tracked) contributes `path\0deleted\n` instead
 * of throwing. Deterministic and independent of commit history.
 */
export function computeSourceFingerprint(files: readonly string[], fs: SourceFileSystem): string {
  const hash = createHash("sha256");
  for (const path of [...files].sort()) {
    const kind = fs.lstat(path);
    if (kind === "missing") {
      hash.update(`${path}\0deleted\n`);
    } else if (kind === "symlink") {
      hash.update(`${path}\0symlink:${fs.readlink(path)}\n`);
    } else {
      hash.update(`${path}\0${sha256Hex(fs.readFile(path))}\n`);
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

function main(): void {
  const files = trackedAndUntrackedFiles();
  const dirtyTreeFingerprint = computeSourceFingerprint(files, realFileSystem);
  console.log(
    JSON.stringify(
      {
        commit: currentCommit(),
        dirtyTreeFingerprint,
        fileCount: files.length,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
