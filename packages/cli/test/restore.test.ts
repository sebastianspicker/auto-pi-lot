import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRestorePoint, restoreRefFor } from "../src/restore.js";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function repository(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "apl-restore-")));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "t");
  await writeFile(join(root, ".gitignore"), "ignored.txt\n.auto-pi-lot/\n");
  await writeFile(join(root, "tracked.txt"), "committed\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return root;
}

test("a restore point snapshots tracked changes and untracked files without touching HEAD, index or tree", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "tracked.txt"), "edited, not committed\n");
  await writeFile(join(root, "new.txt"), "untracked\n");
  await writeFile(join(root, "ignored.txt"), "ignored\n");
  await mkdir(join(root, ".auto-pi-lot"));
  const head = git(root, "rev-parse", "HEAD");
  const status = git(root, "status", "--porcelain");

  const point = await createRestorePoint(root, "run 1..x");
  assert.equal(point.ref, restoreRefFor("run 1..x"));
  assert.match(point.ref, /^refs\/auto-pi-lot\/restore\/run%201%2e%2ex$/);
  assert.equal(point.dirty, true);
  assert.equal(git(root, "rev-parse", point.ref), point.commit);
  assert.equal(git(root, "rev-parse", `${point.commit}^`), head);
  assert.equal(git(root, "show", `${point.commit}:tracked.txt`), "edited, not committed");
  assert.equal(git(root, "show", `${point.commit}:new.txt`), "untracked");
  assert.equal(spawnSync("git", ["cat-file", "-e", `${point.commit}:ignored.txt`], { cwd: root }).status, 128);

  assert.equal(git(root, "rev-parse", "HEAD"), head, "HEAD unchanged");
  assert.equal(git(root, "status", "--porcelain"), status, "index and working tree unchanged");
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "edited, not committed\n");
});

test("a clean tree gives a restore point that is not dirty, and a subdirectory workspace snapshots the repository", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "sub"));
  await writeFile(join(root, "sub", "a.txt"), "a\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "sub");
  const point = await createRestorePoint(join(root, "sub"), "clean");
  assert.equal(point.dirty, false);
  assert.equal(point.root, root);
  assert.equal(git(root, "show", `${point.commit}:tracked.txt`), "committed");
});

test("a repository without commits still gets a restore point", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "apl-restore-unborn-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  await writeFile(join(root, "first.txt"), "first\n");
  const point = await createRestorePoint(root, "unborn");
  assert.equal(point.dirty, true);
  assert.equal(git(root, "show", `${point.commit}:first.txt`), "first");
});

test("the runtime directory never enters a restore point, even when .gitignore does not list it", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "apl-restore-runtime-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "t");
  await writeFile(join(root, "a.txt"), "a\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  for (const dir of [join(root, ".auto-pi-lot"), join(root, "sub", ".auto-pi-lot")]) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "run.lock"), "owner\n");
  }
  const point = await createRestorePoint(root, "runtime");
  assert.equal(point.dirty, false, "only runtime state differs from HEAD");
  assert.equal(git(root, "ls-tree", "-r", "--name-only", point.commit), "a.txt");
});
