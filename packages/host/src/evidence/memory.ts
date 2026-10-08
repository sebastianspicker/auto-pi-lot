import { createHash } from "node:crypto";

import {
  type ArtifactStore,
  digest,
  type EvidenceRecord,
  EvidenceRecordSchema,
  type EvidenceStore,
  parseDto,
} from "@auto-pi-lot/core";

/** Largest artifact either store accepts, in bytes. */
export const MAX_ARTIFACT_BYTES = 16 * 1_048_576;

/** Checks a record is valid and that its id is the digest of its content; returns the parsed copy. */
export function validateEvidence(record: unknown): EvidenceRecord {
  const parsed = parseDto(EvidenceRecordSchema, record);
  if (!parsed.ok) {
    throw new Error(`Refusing to store an invalid evidence record: ${parsed.issues.map((i) => i.message).join("; ")}`);
  }
  const { id, ...content } = parsed.value;
  if (digest(content) !== id) throw new Error(`Evidence record id ${id} does not match its content digest`);
  return parsed.value;
}

export function artifactId(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** In-memory evidence store. Records are validated and deep-copied on the way in and out. */
export class MemoryEvidenceStore implements EvidenceStore {
  readonly #records = new Map<string, EvidenceRecord>();

  async put(record: EvidenceRecord): Promise<string> {
    const valid = validateEvidence(record);
    if (!this.#records.has(valid.id)) this.#records.set(valid.id, structuredClone(valid));
    return valid.id;
  }

  async get(id: string): Promise<EvidenceRecord | null> {
    const found = this.#records.get(id);
    return found === undefined ? null : structuredClone(found);
  }

  async listForRun(runId: string): Promise<readonly EvidenceRecord[]> {
    return [...this.#records.values()]
      .filter((record) => record.runId === runId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((record) => structuredClone(record));
  }
}

/** In-memory artifact store. Bytes are copied on the way in and out. */
export class MemoryArtifactStore implements ArtifactStore {
  readonly #artifacts = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array): Promise<string> {
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new Error(`Refusing to store an artifact larger than ${MAX_ARTIFACT_BYTES} bytes`);
    }
    const id = artifactId(bytes);
    if (!this.#artifacts.has(id)) this.#artifacts.set(id, Uint8Array.from(bytes));
    return id;
  }

  async get(id: string): Promise<Uint8Array | null> {
    const found = this.#artifacts.get(id);
    return found === undefined ? null : Uint8Array.from(found);
  }
}
