import { createHash } from "node:crypto";

/** Longest encoding used as is: `run-<encoded>.jsonl` then stays within the 255-byte file name limit. */
const MAX_ENCODED_RUN_ID = 245;

/**
 * Keeps `[a-z0-9]`, `-`, `_` and `.`; percent-encodes every other UTF-8 byte (lowercase hex).
 * An encoding longer than 245 characters would not fit in a file name, so it becomes its first
 * 200 characters, `%%` and 16 hex characters of the id's sha256. A plain encoding never contains
 * `%%` (every `%` is followed by two hex digits), so a shortened name cannot equal another id's
 * plain one. Every id that fits keeps its path.
 */
export function encodeRunId(runId: string): string {
  let encoded = "";
  for (const byte of new TextEncoder().encode(runId)) {
    const char = String.fromCharCode(byte);
    encoded += /[a-z0-9_.-]/.test(char) ? char : `%${byte.toString(16).padStart(2, "0")}`;
  }
  if (encoded.length <= MAX_ENCODED_RUN_ID) return encoded;
  return `${encoded.slice(0, 200)}%%${createHash("sha256").update(runId).digest("hex").slice(0, 16)}`;
}
