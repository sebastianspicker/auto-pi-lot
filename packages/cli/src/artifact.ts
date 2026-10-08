import { resolve } from "node:path";

import { EvidenceCorruptError, FileArtifactStore } from "@auto-pi-lot/host";

import { parseFlags } from "./args.js";
import { runtimePaths } from "./paths.js";
import { sanitizeLine } from "./run.js";

export const ARTIFACT_USAGE = "Usage: auto-pi-lot artifact <id> [--workspace <dir>]";

export interface ArtifactOptions {
  readonly id: string;
  readonly workspace: string | null;
}

export function parseArtifactArgs(
  args: readonly string[],
): { ok: true; options: ArtifactOptions } | { ok: false; error: string } {
  const parsed = parseFlags(args, { values: ["--workspace"], switches: [], positionals: 1 });
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    options: { id: parsed.flags.positionals[0] ?? "", workspace: parsed.flags.values.get("--workspace") ?? null },
  };
}

/** Writes an artifact's bytes to stdout. Returns the exit code: 1 for an unknown id, 2 for a corrupt artifact. */
export async function runArtifact(args: readonly string[]): Promise<number> {
  const parsed = parseArtifactArgs(args);
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error(ARTIFACT_USAGE);
    return 1;
  }
  const paths = runtimePaths(resolve(parsed.options.workspace ?? process.cwd()));
  let bytes: Uint8Array | null;
  try {
    bytes = await new FileArtifactStore(paths.artifacts).get(parsed.options.id);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof EvidenceCorruptError ? 2 : 1;
  }
  if (bytes === null) {
    console.error(`Unknown artifact: ${parsed.options.id}`);
    return 1;
  }
  // On a terminal, control sequences in a log (a test that prints OSC or CSI codes) are shown escaped
  // rather than executed; piped output stays byte-exact.
  const out = process.stdout.isTTY ? Buffer.from(sanitizeLine(Buffer.from(bytes).toString("utf8")), "utf8") : bytes;
  await new Promise<void>((done, fail) => process.stdout.write(out, (error) => (error ? fail(error) : done())));
  return 0;
}
