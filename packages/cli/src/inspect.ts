import { resolve } from "node:path";

import { replay } from "@auto-pi-lot/core";
import { FileEvidenceStore, FileJournalStore } from "@auto-pi-lot/host";

import { parseFlags } from "./args.js";
import { summarizeEvidence } from "./evidence-summary.js";
import { runtimePaths } from "./paths.js";
import { attemptNodes, summarizeAttempts, summarizeEvent, summarizeNodes } from "./summary.js";

export const INSPECT_USAGE = "Usage: auto-pi-lot inspect <runId> [--workspace <dir>] [--journal <dir>]";

export interface InspectOptions {
  readonly runId: string;
  readonly workspace: string | null;
  readonly journalDir: string | null;
}

export function parseInspectArgs(
  args: readonly string[],
): { ok: true; options: InspectOptions } | { ok: false; error: string } {
  const parsed = parseFlags(args, { values: ["--workspace", "--journal"], switches: [], positionals: 1 });
  if (!parsed.ok) return parsed;
  const { values, positionals } = parsed.flags;
  return {
    ok: true,
    options: {
      runId: positionals[0] ?? "",
      workspace: values.get("--workspace") ?? null,
      journalDir: values.get("--journal") ?? null,
    },
  };
}

/** Prints what the journal and the evidence store hold for one run. Read-only. Returns the exit code. */
export async function runInspect(args: readonly string[]): Promise<number> {
  const parsed = parseInspectArgs(args);
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error(INSPECT_USAGE);
    return 1;
  }
  const { runId } = parsed.options;
  const paths = runtimePaths(
    resolve(parsed.options.workspace ?? process.cwd()),
    parsed.options.journalDir ?? undefined,
  );
  let stored: Awaited<ReturnType<FileJournalStore["read"]>>;
  try {
    stored = await new FileJournalStore(paths.journal).read(runId);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (stored.events.length === 0) {
    console.error(`No journal found for run ${runId}`);
    return 1;
  }
  const replayed = replay(stored.events);
  if (replayed.rejections.length > 0) {
    console.error(`Journal for run ${runId} does not replay:`);
    console.error(JSON.stringify(replayed.rejections, null, 2));
    return 2;
  }
  const { state } = replayed;
  let records: Awaited<ReturnType<FileEvidenceStore["listForRun"]>>;
  try {
    records = await new FileEvidenceStore(paths.evidence).listForRun(runId);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  console.log(
    JSON.stringify(
      {
        mode: "inspect",
        runId,
        status: state.status,
        policy: state.policy,
        tornTail: stored.tornTail,
        nodes: summarizeNodes(state),
        attempts: summarizeAttempts(state),
        events: stored.events.map(summarizeEvent),
        evidence: summarizeEvidence(records, { nodeIds: Object.keys(state.nodes), attemptNodes: attemptNodes(state) }),
      },
      null,
      2,
    ),
  );
  return 0;
}
