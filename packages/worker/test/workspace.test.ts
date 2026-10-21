import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createFingerprintCache,
  type FileKind,
  fingerprintWorkspace,
  listWorkspaceFiles,
  type WorkspaceDeps,
} from "../src/index.js";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

interface FakeTree {
  readonly files: Record<string, string>;
  readonly links?: Record<string, string>;
  readonly missing?: readonly string[];
}

function depsFor(root: string, tree: FakeTree, listing: string[]): WorkspaceDeps {
  const rel = (absolute: string): string => path.relative(root, absolute);
  return {
    listFiles: async () => listing,
    lstat: async (absolute): Promise<FileKind> => {
      const name = rel(absolute);
      if (tree.links && name in tree.links) return "symlink";
      if (name in tree.files) return "file";
      return "missing";
    },
    readFile: async (absolute) => Buffer.from(tree.files[rel(absolute)] ?? ""),
    readlink: async (absolute) => tree.links?.[rel(absolute)] ?? "",
  };
}

test("fingerprint hashes sorted path lines and is order independent", async () => {
  const root = path.resolve("/virtual/root");
  const tree: FakeTree = { files: { "b.txt": "B", "a.txt": "A" } };
  const first = await fingerprintWorkspace(root, depsFor(root, tree, ["b.txt", "a.txt"]));
  const second = await fingerprintWorkspace(root, depsFor(root, tree, ["a.txt", "b.txt"]));
  const expected = createHash("sha256")
    .update(`a.txt\0${sha("A")}\nb.txt\0${sha("B")}\n`)
    .digest("hex");
  assert.equal(first, `sha256:${expected}`);
  assert.equal(second, first);
});

test("fingerprint changes when content changes", async () => {
  const root = path.resolve("/virtual/root");
  const before = await fingerprintWorkspace(root, depsFor(root, { files: { "a.txt": "A" } }, ["a.txt"]));
  const after = await fingerprintWorkspace(root, depsFor(root, { files: { "a.txt": "A2" } }, ["a.txt"]));
  assert.notEqual(before, after);
});

test("a symlink contributes its target string, a missing path contributes deleted", async () => {
  const root = path.resolve("/virtual/root");
  const tree: FakeTree = { files: {}, links: { link: "target/file" } };
  const result = await fingerprintWorkspace(root, depsFor(root, tree, ["link", "gone.txt"]));
  const expected = createHash("sha256").update("gone.txt\0deleted\nlink\0symlink:target/file\n").digest("hex");
  assert.equal(result, `sha256:${expected}`);
});

test("runtime state under .auto-pi-lot is dropped", async () => {
  const root = path.resolve("/virtual/root");
  const tree: FakeTree = { files: { "a.txt": "A", ".auto-pi-lot/journal.jsonl": "x" } };
  const withState = await fingerprintWorkspace(root, depsFor(root, tree, ["a.txt", ".auto-pi-lot/journal.jsonl"]));
  const without = await fingerprintWorkspace(root, depsFor(root, tree, ["a.txt"]));
  assert.equal(withState, without);
});

test("paths that resolve outside the root are skipped", async () => {
  const root = path.resolve("/virtual/root");
  let read = 0;
  const deps: WorkspaceDeps = {
    listFiles: async () => ["a.txt", "../outside.txt", "/etc/passwd", "sub/../../escape"],
    lstat: async () => "file",
    readFile: async () => {
      read += 1;
      return Buffer.from("A");
    },
  };
  const result = await fingerprintWorkspace(root, deps);
  assert.equal(read, 1);
  const expected = createHash("sha256")
    .update(`a.txt\0${sha("A")}\n`)
    .digest("hex");
  assert.equal(result, `sha256:${expected}`);
});

test("listing uses git output when git succeeds", async () => {
  const calls: (readonly string[])[] = [];
  const files = await listWorkspaceFiles("/some/root", async (_file, args) => {
    calls.push(args);
    return { stdout: "a.txt\0dir/b.txt\0" };
  });
  assert.deepEqual(files, ["a.txt", "dir/b.txt"]);
  assert.deepEqual(calls[0], [
    "-C",
    "/some/root",
    "-c",
    "core.fsmonitor=false",
    "ls-files",
    "-z",
    "-co",
    "--exclude-standard",
  ]);
});

test("listing falls back to a walk when git fails, skipping .git, node_modules and .auto-pi-lot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "apl-workspace-"));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, "node_modules"));
  await mkdir(path.join(root, ".auto-pi-lot"));
  await writeFile(path.join(root, "a.txt"), "A");
  await writeFile(path.join(root, "src", "b.txt"), "B");
  await writeFile(path.join(root, ".git", "HEAD"), "ref");
  await writeFile(path.join(root, "node_modules", "dep.js"), "x");
  await writeFile(path.join(root, ".auto-pi-lot", "state"), "x");
  await symlink("a.txt", path.join(root, "link"));

  const failingGit = async (): Promise<{ stdout: string }> => {
    throw new Error("not a git repository");
  };
  const files = (await listWorkspaceFiles(root, failingGit)).sort();
  assert.deepEqual(files, ["a.txt", "link", "src/b.txt"]);

  const first = await fingerprintWorkspace(root, { execFile: failingGit });
  await writeFile(path.join(root, ".auto-pi-lot", "state"), "changed");
  assert.equal(await fingerprintWorkspace(root, { execFile: failingGit }), first);
  await writeFile(path.join(root, "a.txt"), "A changed");
  assert.notEqual(await fingerprintWorkspace(root, { execFile: failingGit }), first);
});

const HOUR_NS = 3_600_000_000_000n;
const wallNs = (): bigint => BigInt(Date.now()) * 1_000_000n;
const LISTING = ["a.txt", "src/b.txt", "link"];

async function cacheFixture(): Promise<{ root: string; reads: string[]; deps: (nowNs: bigint) => WorkspaceDeps }> {
  const root = await mkdtemp(path.join(tmpdir(), "apl-fpcache-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "a.txt"), "AAAA");
  await writeFile(path.join(root, "src", "b.txt"), "BBBB");
  await symlink("a.txt", path.join(root, "link"));
  const reads: string[] = [];
  const cache = createFingerprintCache();
  const deps = (nowNs: bigint): WorkspaceDeps => ({
    listFiles: async () => LISTING,
    readFile: async (absolute) => {
      reads.push(path.relative(root, absolute));
      return readFile(absolute);
    },
    cache,
    nowNs: () => nowNs,
  });
  return { root, reads, deps };
}

test("a cache does not change the fingerprint", async () => {
  const { root, deps } = await cacheFixture();
  const plain = await fingerprintWorkspace(root, { listFiles: async () => LISTING });
  const cached = await fingerprintWorkspace(root, deps(wallNs() + HOUR_NS));
  const warm = await fingerprintWorkspace(root, deps(wallNs() + HOUR_NS));
  assert.equal(cached, plain);
  assert.equal(warm, plain);
});

test("a warm cache reads no file contents when nothing changed", async () => {
  const { root, reads, deps } = await cacheFixture();
  await fingerprintWorkspace(root, deps(wallNs() + HOUR_NS));
  assert.deepEqual([...reads].sort(), ["a.txt", "src/b.txt"]);
  reads.length = 0;
  await fingerprintWorkspace(root, deps(wallNs() + 2n * HOUR_NS));
  assert.deepEqual(reads, []);
});

test("a changed file with the same size is re-hashed", async () => {
  const { root, reads, deps } = await cacheFixture();
  const before = await fingerprintWorkspace(root, deps(wallNs() + HOUR_NS));
  reads.length = 0;
  await writeFile(path.join(root, "a.txt"), "ZZZZ");
  const bumped = new Date(Date.now() + 10_000);
  await utimes(path.join(root, "a.txt"), bumped, bumped);
  const after = await fingerprintWorkspace(root, deps(wallNs() + HOUR_NS));
  assert.deepEqual(reads, ["a.txt"]);
  assert.notEqual(after, before);
  assert.equal(after, await fingerprintWorkspace(root, { listFiles: async () => LISTING }));
});

test("an entry hashed less than 2 s after the file's ctime or mtime is read again", async () => {
  const racy = await cacheFixture();
  const stat = await lstat(path.join(racy.root, "a.txt"), { bigint: true });
  const newest = stat.mtimeNs > stat.ctimeNs ? stat.mtimeNs : stat.ctimeNs;
  await fingerprintWorkspace(racy.root, racy.deps(newest + 1_000_000_000n));
  racy.reads.length = 0;
  await fingerprintWorkspace(racy.root, racy.deps(wallNs() + HOUR_NS));
  assert.ok(racy.reads.includes("a.txt"));

  // Hashed well after the newest time: trusted on the next call.
  const trusted = await cacheFixture();
  await fingerprintWorkspace(trusted.root, trusted.deps(wallNs() + HOUR_NS));
  trusted.reads.length = 0;
  await fingerprintWorkspace(trusted.root, trusted.deps(wallNs() + 2n * HOUR_NS));
  assert.deepEqual(trusted.reads, []);

  // A modification time in the future is never trusted, even when ctime is old enough.
  const future = await cacheFixture();
  const ahead = new Date(Date.now() + 2 * 3_600_000);
  await utimes(path.join(future.root, "a.txt"), ahead, ahead);
  await fingerprintWorkspace(future.root, future.deps(wallNs() + HOUR_NS));
  future.reads.length = 0;
  await fingerprintWorkspace(future.root, future.deps(wallNs() + HOUR_NS));
  assert.deepEqual(future.reads, ["a.txt"]);
});

test("a deleted file drops out of the cache and fingerprints as deleted", async () => {
  const { root, deps } = await cacheFixture();
  await fingerprintWorkspace(root, deps(wallNs() + HOUR_NS));
  await rm(path.join(root, "src", "b.txt"));
  const cached = await fingerprintWorkspace(root, deps(wallNs() + HOUR_NS));
  assert.equal(cached, await fingerprintWorkspace(root, { listFiles: async () => LISTING }));
  const expected = createHash("sha256")
    .update(`a.txt\0${sha("AAAA")}\nlink\0symlink:a.txt\nsrc/b.txt\0deleted\n`)
    .digest("hex");
  assert.equal(cached, `sha256:${expected}`);
});

test("a symlink is still recorded as its target with a cache", async () => {
  const { root, deps } = await cacheFixture();
  await fingerprintWorkspace(root, deps(wallNs() + HOUR_NS));
  await rm(path.join(root, "link"));
  await symlink("src/b.txt", path.join(root, "link"));
  const cached = await fingerprintWorkspace(root, deps(wallNs() + HOUR_NS));
  const expected = createHash("sha256")
    .update(`a.txt\0${sha("AAAA")}\nlink\0symlink:src/b.txt\nsrc/b.txt\0${sha("BBBB")}\n`)
    .digest("hex");
  assert.equal(cached, `sha256:${expected}`);
});
