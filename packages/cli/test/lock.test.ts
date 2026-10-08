import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireLock, acquireRunLocks } from "../src/lock.js";

test("a second process cannot acquire a lock and release permits a later owner", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "apl-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "run.lock");
  const unlock = await acquireLock(file, dir);
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { acquireLock } from ${JSON.stringify(new URL("../dist/lock.js", import.meta.url).href)};
    await acquireLock(process.argv[1], process.argv[2]);
  `,
      file,
      dir,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 1);
  assert.match(child.stderr, /Run lock exists/);
  await unlock();
  const next = await acquireLock(file, dir);
  await next();
  await assert.rejects(readFile(file), { code: "ENOENT" });
});

test("partial lock acquisition rolls back and never removes another owner", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "apl-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = join(dir, "a.lock");
  const second = join(dir, "b.lock");
  const held = await acquireLock(second, dir);
  await assert.rejects(acquireRunLocks([first, second], dir), /Run lock exists/);
  await assert.rejects(readFile(first), { code: "ENOENT" });
  await held();
  const release = await acquireLock(first, dir);
  await writeFile(first, "replacement");
  await release();
  assert.equal(await readFile(first, "utf8"), "replacement");
});
