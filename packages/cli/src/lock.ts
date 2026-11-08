import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

/** The "lock exists" message, with the owner the file records and whether that process is gone. */
export async function lockMessage(file: string): Promise<string> {
  let holder = "";
  try {
    const {
      pid,
      hostname: host,
      startedAt,
    } = JSON.parse(await readFile(file, "utf8")) as {
      pid: number;
      hostname: string;
      startedAt: string;
    };
    holder = ` Held by pid ${pid} on host ${host} since ${startedAt}`;
    if (host === hostname()) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") holder += " (process not found)";
      }
    }
    holder += ".";
  } catch {
    // An unreadable or foreign lock file: the generic message still applies.
  }
  return `Run lock exists at ${file}.${holder} Another run may be active. After confirming its process and checks have stopped, remove this lock file and retry.`;
}

/** Advisory ownership between CLI processes. Never steal a lock from a potentially live writer. */
export async function acquireLock(file: string, workspace: string): Promise<() => Promise<void>> {
  await mkdir(dirname(file), { recursive: true });
  const owner = `${JSON.stringify({ token: randomUUID(), pid: process.pid, hostname: hostname(), workspace, startedAt: new Date().toISOString() })}\n`;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(await lockMessage(file));
  }
  try {
    await handle.writeFile(owner);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(file);
    throw error;
  }
  await handle.close();
  return async () => {
    // A manually replaced lock belongs to somebody else.
    try {
      if (!(await lstat(file)).isFile()) return;
      if ((await readFile(file, "utf8")) === owner) await unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
}

/** Stable order plus rollback avoids deadlocks and leaked ownership on partial acquisition. */
export async function acquireRunLocks(files: readonly string[], workspace: string): Promise<() => Promise<void>> {
  const releases: (() => Promise<void>)[] = [];
  const release = async (): Promise<void> => {
    const results = await Promise.allSettled(releases.reverse().map((unlock) => unlock()));
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  };
  try {
    for (const file of [...new Set(files)].sort()) releases.push(await acquireLock(file, workspace));
  } catch (error) {
    await release();
    throw error;
  }
  return release;
}
