import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRestorePoint,
  discardRestorePoint,
  removeActiveRestoreIndex,
  restoreHint,
  restoreRefFor,
} from "../src/restore.js";

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

test("long run ids get a restore point whose ref name fits", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const runId of [`Übungsblätter-${"Ä".repeat(40)}`, `run${".".repeat(120)}`]) {
    const point = await createRestorePoint(root, runId);
    assert.equal(git(root, "rev-parse", point.ref), point.commit);
    assert.ok(point.ref.slice("refs/auto-pi-lot/restore/".length).length <= 255);
  }
});

test("a second restore point for the same run id is refused and the first snapshot is kept", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "tracked.txt"), "before the run\n");
  const first = await createRestorePoint(root, "same-run");
  await writeFile(join(root, "tracked.txt"), "edited by the run\n");
  await assert.rejects(createRestorePoint(root, "same-run"), /already has a restore point.*--run-id/);
  assert.equal(git(root, "rev-parse", first.ref), first.commit, "the first snapshot is still referenced");
  assert.equal(git(root, "show", `${first.ref}:tracked.txt`), "before the run");
  const leftovers = (await readdir(git(root, "rev-parse", "--absolute-git-dir"))).filter((name) =>
    name.startsWith("auto-pi-lot-restore-index-"),
  );
  assert.deepEqual(leftovers, [], "no temporary restore index is left behind");
});

test("discarding a restore point removes only its own ref, so the run id can be used again", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const unused = await createRestorePoint(root, "never-started");
  await discardRestorePoint(unused);
  assert.equal(spawnSync("git", ["rev-parse", "--verify", "--quiet", unused.ref], { cwd: root }).status, 1);
  const again = await createRestorePoint(root, "never-started");
  assert.equal(git(root, "rev-parse", again.ref), again.commit);

  await writeFile(join(root, "tracked.txt"), "changed\n");
  const other = await createRestorePoint(root, "other-run");
  // A ref that no longer points at the snapshot this process made is left alone.
  await assert.rejects(discardRestorePoint({ ...other, commit: again.commit }));
  assert.equal(git(root, "rev-parse", other.ref), other.commit);
});

test("removing the active restore index is a no-op once the restore point is finished", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  removeActiveRestoreIndex();
  const point = await createRestorePoint(root, "finished");
  removeActiveRestoreIndex();
  assert.equal(git(root, "rev-parse", point.ref), point.commit);
});

test("the restore hint limits the pathspec to the workspace inside the repository", () => {
  const point = { ref: "refs/auto-pi-lot/restore/r", commit: "a".repeat(40), root: "/repo", dirty: false };
  const sub = restoreHint(point, "/repo/sub");
  assert.match(sub, /git -C \/repo restore --source=refs\/auto-pi-lot\/restore\/r --worktree -- sub /);
  assert.match(sub, /edits made in that path after the run started are overwritten too/);
  assert.match(restoreHint(point, "/repo"), /--worktree -- \. /);
  assert.match(sub, /gitignored files are not included/);
});
