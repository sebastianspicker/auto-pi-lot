import { open, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { type JournalEvent, parseJournalEvent, type RunStatus, replay } from "@auto-pi-lot/core";
import { FileJournalStore, MAX_RECORD_BYTES } from "@auto-pi-lot/host";

import { parseFlags } from "./args.js";
import { runtimePaths } from "./paths.js";

export const STATUS_USAGE = "Usage: auto-pi-lot status [--workspace <dir>] [--journal <dir>]";

export interface StatusOptions {
  readonly workspace: string | null;
  readonly journalDir: string | null;
}

export function parseStatusArgs(
  args: readonly string[],
): { ok: true; options: StatusOptions } | { ok: false; error: string } {
  const parsed = parseFlags(args, { values: ["--workspace", "--journal"], switches: [] });
  if (!parsed.ok) return parsed;
  const { values } = parsed.flags;
  return {
    ok: true,
    options: { workspace: values.get("--workspace") ?? null, journalDir: values.get("--journal") ?? null },
  };
}

export interface RunListing {
  readonly runId: string;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly lastEventAt: string;
  readonly nodeCount: number;
  readonly eventCount: number;
  readonly graphId: string | null;
}

export interface RunListingError {
  readonly runId: string;
  readonly error: string;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The first complete record of a journal file, read without loading the whole file. */
async function firstEvent(path: string): Promise<JournalEvent> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (end < 0) throw new Error("no complete first record");
    let value: unknown;
    try {
      value = JSON.parse(buffer.subarray(0, end).toString("utf8"));
    } catch {
      throw new Error("first record is not valid JSON");
    }
    // Each line is a `{ seq, digest, event }` envelope; the store verifies seq and digest on the full read.
    const parsed = parseJournalEvent(
      typeof value === "object" && value !== null && "event" in value ? value.event : null,
    );
    if (!parsed.ok) throw new Error("first record is not a valid journal event");
    return parsed.value;
  } finally {
    await handle.close();
  }
}

async function listing(
  store: FileJournalStore,
  file: string,
  directory: string,
): Promise<RunListing | RunListingError> {
  try {
    const first = await firstEvent(join(directory, file));
    if (basename(store.pathFor(first.runId)) !== file) {
      return { runId: file, error: `file name does not match its run id ${first.runId}` };
    }
    const stored = await store.read(first.runId);
    const replayed = replay(stored.events);
    if (replayed.rejections.length > 0) {
      return { runId: first.runId, error: `journal does not replay (${replayed.rejections.length} rejected events)` };
    }
    const last = stored.events.at(-1) ?? first;
    return {
      runId: first.runId,
      status: replayed.state.status,
      startedAt: first.at,
      lastEventAt: last.at,
      nodeCount: replayed.state.graph?.nodes.length ?? 0,
      eventCount: stored.events.length,
      graphId: replayed.state.graph?.id ?? null,
    };
  } catch (error) {
    return { runId: file, error: message(error) };
  }
}

/** Lists every run in the journal directory, newest activity first. Read-only. Returns the exit code. */
export async function runStatus(args: readonly string[]): Promise<number> {
  const parsed = parseStatusArgs(args);
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error(STATUS_USAGE);
    return 1;
  }
  const directory = runtimePaths(
    resolve(parsed.options.workspace ?? process.cwd()),
    parsed.options.journalDir ?? undefined,
  ).journal;
  let files: string[];
  try {
    files = (await readdir(directory)).filter((name) => /^run-.*\.jsonl$/.test(name)).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") files = [];
    else {
      console.error(message(error));
      return 2;
    }
  }
  const store = new FileJournalStore(directory);
  const entries = await Promise.all(files.map((file) => listing(store, file, directory)));
  const runs = entries.sort((a, b) => {
    if ("error" in a || "error" in b) return "error" in a ? ("error" in b ? 0 : 1) : -1;
    return a.lastEventAt < b.lastEventAt ? 1 : a.lastEventAt > b.lastEventAt ? -1 : 0;
  });
  console.log(JSON.stringify({ mode: "status", runs }, null, 2));
  return 0;
}
