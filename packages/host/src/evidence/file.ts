import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  type ArtifactStore,
  digest,
  type EvidenceRecord,
  EvidenceRecordSchema,
  type EvidenceStore,
  parseDto,
} from "@auto-pi-lot/core";

import { encodeRunId } from "../paths.js";
import { artifactId, MAX_ARTIFACT_BYTES, validateEvidence } from "./memory.js";

export { MAX_ARTIFACT_BYTES };

/** An evidence file that is unreadable, invalid, or whose id is not the digest of its content. */
export class EvidenceCorruptError extends Error {
  readonly path: string;
  readonly reason: string;

  constructor(path: string, reason: string) {
    super(`Evidence file ${path} is corrupt: ${reason}`);
    this.name = "EvidenceCorruptError";
    this.path = path;
    this.reason = reason;
  }
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const ID_PATTERN = /^sha256:([0-9a-f]{64})$/;

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function hexOf(id: string): string {
  const match = ID_PATTERN.exec(id);
  if (match?.[1] === undefined) throw new Error(`Not a sha256 id: ${id}`);
  return match[1];
}

/** Opens `path` without following a symlink and refuses anything that is not a regular file. */
async function openRegular(path: string, flags: number, mode?: number): Promise<FileHandle> {
  const handle = await open(path, flags | NOFOLLOW, mode);
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Path ${path} is not a regular file`);
  } catch (error) {
    await handle.close();
    throw error;
  }
  return handle;
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some platforms cannot open or fsync a directory.
  }
}

/** Writes `data` to `path` atomically: temp file, fsync, rename. An existing file is left as is. */
async function writeAtomic(directory: string, path: string, data: Uint8Array): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${randomBytes(8).toString("hex")}`;
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  await syncDirectory(directory);
}

/** Longest file either store reads; a bigger one is corrupt, never loaded. Artifacts are bounded on `put` to the same size. */
const MAX_READ_BYTES = MAX_ARTIFACT_BYTES;

async function readRegular(path: string): Promise<Buffer | null> {
  try {
    const handle = await openRegular(path, constants.O_RDONLY);
    try {
      const { size } = await handle.stat();
      if (size > MAX_READ_BYTES) throw new EvidenceCorruptError(path, `file is larger than ${MAX_READ_BYTES} bytes`);
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/**
 * Durable evidence store: one JSON file per record, `<directory>/run-<encoded runId>/<kind>-<hex>.json`,
 * where `<hex>` is the hex part of the record id. Files are written atomically (temp file, fsync,
 * rename), created with mode 0600 in 0700 directories, and never opened through a symbolic link.
 * `get(id)` does not know the run, so it scans the `run-*` directories for `*-<hex>.json`; the
 * index is just the file names, so there is nothing to rebuild. A run's evidence is small; this
 * is not meant for large stores.
 */
export class FileEvidenceStore implements EvidenceStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  #runDirectory(runId: string): string {
    return join(this.#directory, `run-${encodeRunId(runId)}`);
  }

  async put(record: EvidenceRecord): Promise<string> {
    const valid = validateEvidence(record);
    const hex = hexOf(valid.id);
    const directory = this.#runDirectory(valid.runId);
    const path = join(directory, `${valid.kind}-${hex}.json`);
    if ((await readRegular(path)) !== null) {
      await this.#load(path, valid.id);
      return valid.id;
    }
    await writeAtomic(directory, path, new TextEncoder().encode(JSON.stringify(valid)));
    return valid.id;
  }

  async get(id: string): Promise<EvidenceRecord | null> {
    const hex = ID_PATTERN.test(id) ? hexOf(id) : null;
    if (hex === null) return null;
    for (const run of await this.#runDirectories()) {
      const directory = join(this.#directory, run);
      for (const name of await this.#files(directory)) {
        if (name.endsWith(`-${hex}.json`)) return this.#load(join(directory, name), id);
      }
    }
    return null;
  }

  async listForRun(runId: string): Promise<readonly EvidenceRecord[]> {
    const directory = this.#runDirectory(runId);
    const records: EvidenceRecord[] = [];
    for (const name of await this.#files(directory)) {
      const match = /^(?:proposal|check|review|acceptance)-([0-9a-f]{64})\.json$/.exec(name);
      if (match?.[1] === undefined) continue;
      const record = await this.#load(join(directory, name), `sha256:${match[1]}`);
      if (record.runId !== runId)
        throw new EvidenceCorruptError(join(directory, name), `record belongs to run ${record.runId}`);
      records.push(record);
    }
    return records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async #runDirectories(): Promise<string[]> {
    try {
      return (await readdir(this.#directory)).filter((name) => name.startsWith("run-"));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  async #files(directory: string): Promise<string[]> {
    try {
      return await readdir(directory);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  async #load(path: string, expectedId: string): Promise<EvidenceRecord> {
    const data = await readRegular(path);
    if (data === null) throw new EvidenceCorruptError(path, "file vanished while reading");
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
    } catch {
      throw new EvidenceCorruptError(path, "file is not valid UTF-8 JSON");
    }
    const parsed = parseDto(EvidenceRecordSchema, value);
    if (!parsed.ok) {
      throw new EvidenceCorruptError(path, `record is invalid: ${parsed.issues.map((i) => i.message).join("; ")}`);
    }
    const { id, ...content } = parsed.value;
    if (digest(content) !== id) throw new EvidenceCorruptError(path, "id does not match the content digest");
    if (id !== expectedId) throw new EvidenceCorruptError(path, `file name says ${expectedId}, record is ${id}`);
    return parsed.value;
  }
}

/** Durable artifact store: `<directory>/<hex>`, written atomically, re-hashed on every read. */
export class FileArtifactStore implements ArtifactStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async put(bytes: Uint8Array): Promise<string> {
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new Error(`Refusing to store an artifact larger than ${MAX_ARTIFACT_BYTES} bytes`);
    }
    const id = artifactId(bytes);
    const path = join(this.#directory, hexOf(id));
    if ((await readRegular(path)) === null) await writeAtomic(this.#directory, path, bytes);
    return id;
  }

  async get(id: string): Promise<Uint8Array | null> {
    if (!ID_PATTERN.test(id)) return null;
    const path = join(this.#directory, hexOf(id));
    const data = await readRegular(path);
    if (data === null) return null;
    if (artifactId(data) !== id) throw new EvidenceCorruptError(path, `content hash does not match ${id}`);
    return Uint8Array.from(data);
  }
}
