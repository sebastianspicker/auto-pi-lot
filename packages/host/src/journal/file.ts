import { constants } from "node:fs";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { join } from "node:path";

import {
  digest,
  type JournalEvent,
  type JournalReadResult,
  type JournalStore,
  parseJournalEvent,
} from "@auto-pi-lot/core";

import { encodeRunId } from "../paths.js";

/** Longest record line (without its newline) the store writes or reads, in bytes. */
export const MAX_RECORD_BYTES = 1_048_576;

/** A record that is complete but unreadable or invalid, or any bad record before the last, means the log is damaged. */
export class JournalCorruptError extends Error {
  readonly runId: string;
  readonly path: string;
  /** 1-based line number of the bad record. */
  readonly line: number;
  readonly reason: string;

  constructor(runId: string, path: string, line: number, reason: string) {
    super(`Journal for run ${runId} is corrupt at ${path}:${line}: ${reason}`);
    this.name = "JournalCorruptError";
    this.runId = runId;
    this.path = path;
    this.line = line;
    this.reason = reason;
  }
}

interface ParsedFile {
  readonly events: JournalEvent[];
  /** Byte length of the valid prefix: everything up to and including the last valid line's newline. */
  readonly validBytes: number;
  readonly tornTail: boolean;
  readonly existed: boolean;
}

interface RunState {
  nextSeq: number;
  existed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** `O_NOFOLLOW` does not exist on Windows. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Opens `path` without following a symlink and refuses anything that is not a regular file. */
async function openRegular(path: string, flags: number, mode?: number): Promise<FileHandle> {
  const handle = await open(path, flags | NOFOLLOW, mode);
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Journal path ${path} is not a regular file`);
  } catch (error) {
    await handle.close();
    throw error;
  }
  return handle;
}

/**
 * Checks one record line. Returns the event when valid, otherwise why it is not: `unreadable`
 * (not UTF-8 or not JSON, what a cut-short write leaves) or `invalid` (complete JSON that is not a
 * valid record).
 */
function checkLine(
  bytes: Uint8Array,
  runId: string,
  expectedSeq: number,
): { event: JournalEvent } | { reason: string; kind: "unreadable" | "invalid" } {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return { reason: "line is not valid UTF-8", kind: "unreadable" };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { reason: "line is not valid JSON", kind: "unreadable" };
  }
  if (!isRecord(value)) return { reason: "record is not an object", kind: "invalid" };
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== "digest" || keys[1] !== "event" || keys[2] !== "seq") {
    return { reason: "record must have exactly seq, digest and event", kind: "invalid" };
  }
  if (value.seq !== expectedSeq)
    return { reason: `expected seq ${expectedSeq}, found ${String(value.seq)}`, kind: "invalid" };
  const parsed = parseJournalEvent(value.event);
  if (!parsed.ok) {
    return { reason: `event is invalid: ${parsed.issues.map((issue) => issue.message).join("; ")}`, kind: "invalid" };
  }
  if (parsed.value.runId !== runId) return { reason: `event belongs to run ${parsed.value.runId}`, kind: "invalid" };
  if (value.digest !== digest(parsed.value)) return { reason: "digest does not match the event", kind: "invalid" };
  return { event: parsed.value };
}

/**
 * Durable, append-only journal: one JSON Lines file per run, one `{seq, digest, event}` record
 * per line. Every append is fsynced before it resolves. Only a torn last line (no trailing
 * newline, or not UTF-8 or JSON) is treated as never written; a complete record that is invalid,
 * last or not, is a durable record gone bad and throws `JournalCorruptError`. Files are opened
 * without following symlinks and must be regular files.
 */
export class FileJournalStore implements JournalStore {
  readonly #directory: string;
  readonly #runs = new Map<string, RunState>();
  readonly #chains = new Map<string, Promise<void>>();

  constructor(directory: string) {
    this.#directory = directory;
  }

  /**
   * The file that holds `runId`'s records. The run id never chooses the path directly: it is
   * encoded to lowercase-safe characters, so two ids differing only by case (or by anything else)
   * never share a file, even on a case-insensitive file system; the `run-` prefix avoids Windows
   * reserved names.
   */
  pathFor(runId: string): string {
    return join(this.#directory, `run-${encodeRunId(runId)}.jsonl`);
  }

  async read(runId: string): Promise<JournalReadResult> {
    const { events, tornTail } = await this.#parse(runId);
    return { events, tornTail };
  }

  append(event: JournalEvent): Promise<void> {
    const parsed = parseJournalEvent(event);
    if (!parsed.ok) {
      return Promise.reject(
        new Error(`Refusing to journal an invalid event: ${parsed.issues.map((issue) => issue.message).join("; ")}`),
      );
    }
    const valid = parsed.value;
    const previous = this.#chains.get(valid.runId) ?? Promise.resolve();
    const next = previous.then(
      () => this.#appendNow(valid),
      () => this.#appendNow(valid),
    );
    this.#chains.set(valid.runId, next);
    return next;
  }

  async #parse(runId: string): Promise<ParsedFile> {
    const path = this.pathFor(runId);
    let data: Buffer;
    try {
      const handle = await openRegular(path, constants.O_RDONLY);
      try {
        data = await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isMissing(error)) return { events: [], validBytes: 0, tornTail: false, existed: false };
      throw error;
    }
    const events: JournalEvent[] = [];
    let offset = 0;
    let lineNumber = 0;
    while (offset < data.length) {
      lineNumber += 1;
      const newline = data.indexOf(0x0a, offset);
      const terminated = newline !== -1;
      const end = terminated ? newline : data.length;
      if (end - offset > MAX_RECORD_BYTES) {
        // append refuses such a line, so not even a torn tail can be this long.
        throw new JournalCorruptError(runId, path, lineNumber, "record exceeds MAX_RECORD_BYTES");
      }
      const checked = checkLine(data.subarray(offset, end), runId, events.length + 1);
      const isLast = !terminated || newline + 1 >= data.length;
      if ("reason" in checked) {
        // Torn: the last line, cut short by a crash. Anything else bad is corrupt, never deleted.
        if (isLast && (!terminated || checked.kind === "unreadable")) {
          return { events, validBytes: offset, tornTail: true, existed: true };
        }
        throw new JournalCorruptError(runId, path, lineNumber, checked.reason);
      }
      if (!terminated) return { events, validBytes: offset, tornTail: true, existed: true };
      events.push(checked.event);
      offset = newline + 1;
    }
    return { events, validBytes: offset, tornTail: false, existed: true };
  }

  async #initialise(runId: string): Promise<RunState> {
    const parsed = await this.#parse(runId);
    if (parsed.tornTail) {
      const handle = await openRegular(this.pathFor(runId), constants.O_RDWR);
      try {
        await handle.truncate(parsed.validBytes);
        await handle.datasync();
      } finally {
        await handle.close();
      }
    }
    return { nextSeq: parsed.events.length + 1, existed: parsed.existed };
  }

  async #appendNow(event: JournalEvent): Promise<void> {
    const runId = event.runId;
    let state = this.#runs.get(runId);
    if (state === undefined) {
      state = await this.#initialise(runId);
      this.#runs.set(runId, state);
    }
    const record = JSON.stringify({ seq: state.nextSeq, digest: digest(event), event });
    if (Buffer.byteLength(record, "utf8") > MAX_RECORD_BYTES) {
      throw new Error(`Refusing to journal a record larger than ${MAX_RECORD_BYTES} bytes`);
    }
    const line = `${record}\n`;
    const created = !state.existed;
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const handle = await openRegular(
        this.pathFor(runId),
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
        0o600,
      );
      try {
        await handle.appendFile(line, "utf8");
        await handle.datasync();
      } finally {
        await handle.close();
      }
      if (created) await this.#syncDirectory();
    } catch (error) {
      // The file may hold a partial line now; re-read it before the next append.
      this.#runs.delete(runId);
      throw error;
    }
    state.nextSeq += 1;
    state.existed = true;
  }

  async #syncDirectory(): Promise<void> {
    try {
      const handle = await open(this.#directory, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Some platforms cannot open or fsync a directory.
    }
  }
}
