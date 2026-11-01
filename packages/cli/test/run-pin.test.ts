import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { JournalEvent, JournalReadResult } from "@auto-pi-lot/core";

import { createRestorePoint } from "../src/restore.js";
import { dropUnusedRestorePoint, pinChecks } from "../src/run.js";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function repository(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "apl-run-pin-")));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "t");
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return root;
}

const journalWith = (events: readonly JournalEvent[] | Error) => ({
  read: async (): Promise<JournalReadResult> => {
    if (events instanceof Error) throw events;
    return { events, tornTail: false };
  },
});

test("a new run pins npm checks in its manifest and fills in defaults", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const [npm, node] = await pinChecks(root, [
    { id: "test", command: "npm", args: ["test"] },
    { id: "plain", command: "node", args: ["--test"], cwd: "src", timeoutMs: 5000 },
  ]);
  assert.match(npm?.definitionDigest ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.equal(npm?.cwd, ".");
  assert.equal(typeof npm?.timeoutMs, "number");
  assert.equal(node?.definitionDigest, undefined, "only npm profiles are pinned");
  assert.deepEqual([node?.cwd, node?.timeoutMs], ["src", 5000]);
});

test("a check whose definition cannot be read stops the run with the check named", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "broken", "package.json"), { recursive: true });
  await assert.rejects(
    pinChecks(root, [{ id: "broken", command: "npm", args: ["test"], cwd: "broken" }]),
    /Cannot pin check broken/,
  );
});

test("an unused restore point is dropped only when the run never journaled anything", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const exists = (ref: string) =>
    spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: root }).status === 0;

  const started = await createRestorePoint(root, "started");
  await dropUnusedRestorePoint(started, journalWith([{} as JournalEvent]), "started");
  assert.ok(exists(started.ref), "a run with journal events keeps its restore point");

  const unreadable = await createRestorePoint(root, "unreadable");
  await dropUnusedRestorePoint(unreadable, journalWith(new Error("corrupt")), "unreadable");
  assert.ok(exists(unreadable.ref), "an unreadable journal keeps the restore point");

  const unused = await createRestorePoint(root, "unused");
  await dropUnusedRestorePoint(unused, journalWith([]), "unused");
  assert.ok(!exists(unused.ref), "a run that never started leaves no restore point behind");
});
