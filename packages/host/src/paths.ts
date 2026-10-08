/** Keeps `[a-z0-9]`, `-`, `_` and `.`; percent-encodes every other UTF-8 byte (lowercase hex). */
export function encodeRunId(runId: string): string {
  let encoded = "";
  for (const byte of new TextEncoder().encode(runId)) {
    const char = String.fromCharCode(byte);
    encoded += /[a-z0-9_.-]/.test(char) ? char : `%${byte.toString(16).padStart(2, "0")}`;
  }
  return encoded;
}
