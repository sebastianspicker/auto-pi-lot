import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  canonicalJson,
  type ExecutionState,
  type FailureCategory,
  type GraphSpec,
  type JournalEvent,
  type ResultDisposition,
  type RunPolicy,
  type RunState,
  replay,
} from "@auto-pi-lot/core";
import { FileJournalStore, type HostPorts, RunHost, ScriptedGate, ScriptedWorker } from "@auto-pi-lot/host";

import { demoGraphInput } from "./demo.js";

export const RUN_USAGE = "Usage: auto-pi-lot run [--journal <dir>] [--resume <runId>]";

/** Where `run` journals by default: the gitignored local runtime directory. */
export const DEFAULT_JOURNAL_DIR = ".auto-pi-lot/journal";

/** Bounds the example run: two slots, and one retry per task so the scripted crash can be retried. */
const DEMO_POLICY: RunPolicy = { maxConcurrent: 2, maxAttemptsPerNode: 2 };

export interface RunOptions {
  readonly journalDir: string;
  readonly resume: string | null;
}

/** Parses `run`'s arguments; never throws, so the entry point can print the usage line. */
export function parseRunArgs(
  args: readonly string[],
): { ok: true; options: RunOptions } | { ok: false; error: string } {
  let journalDir = DEFAULT_JOURNAL_DIR;
  let resume: string | null = null;
  let seenJournal = false;
  let seenResume = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg !== "--journal" && arg !== "--resume") {
      return { ok: false, error: `Unknown or incomplete argument: ${String(arg)}` };
    }
    // A missing, empty or flag-like value is an incomplete argument.
    if (value === undefined || value === "" || value.startsWith("--")) {
      return { ok: false, error: `Unknown or incomplete argument: ${arg}` };
    }
    if (arg === "--journal") {
      if (seenJournal) return { ok: false, error: "--journal given twice" };
      seenJournal = true;
      journalDir = value;
    } else {
      if (seenResume) return { ok: false, error: "--resume given twice" };
      seenResume = true;
      resume = value;
    }
    index += 1;
  }
  return { ok: true, options: { journalDir, resume } };
}

interface NodeSummary {
  readonly execution: ExecutionState;
  readonly disposition: ResultDisposition | null;
  readonly attemptCount: number;
  readonly invalidatedAttemptCount: number;
  readonly failureCategory: FailureCategory | null;
}

/** One journal event with only its identifying fields; the full record is in the journal file. */
interface EventSummary {
  readonly index: number;
  readonly type: JournalEvent["type"];
  readonly at: string;
  readonly nodeId?: string;
  readonly attemptId?: string;
  readonly fencingToken?: number;
  readonly category?: FailureCategory;
  readonly decision?: "accepted" | "rejected";
  readonly receiptIds?: readonly string[];
  readonly reason?: string;
}

export interface FakeRunOutput {
  readonly mode: "fake-run";
  readonly runId: string;
  readonly journal: string;
  readonly resumed: boolean;
  readonly tornTail: boolean;
  readonly finalStatus: "succeeded" | "failed" | "cancelled";
  readonly events: readonly EventSummary[];
  readonly rejections: readonly {
    readonly type: JournalEvent["type"];
    readonly code: string;
    readonly message: string;
  }[];
  readonly nodes: Readonly<Record<string, NodeSummary>>;
  /** Replaying the journal reproduces the live state; false would be a reducer or store bug. */
  readonly replayMatches: boolean;
}

function summarizeEvent(event: JournalEvent, index: number): EventSummary {
  const base = { index, type: event.type, at: event.at };
  switch (event.type) {
    case "run_started":
      return base;
    case "attempt_dispatched":
      return { ...base, nodeId: event.nodeId, attemptId: event.attemptId, fencingToken: event.fencingToken };
    case "result_proposed":
      return { ...base, attemptId: event.attemptId, fencingToken: event.fencingToken };
    case "acceptance_decided":
      return {
        ...base,
        nodeId: event.nodeId,
        attemptId: event.attemptId,
        decision: event.decision,
        receiptIds: event.receiptIds,
      };
    case "attempt_failed":
      return { ...base, attemptId: event.attemptId, fencingToken: event.fencingToken, category: event.category };
    case "lease_expired":
      return { ...base, attemptId: event.attemptId, fencingToken: event.fencingToken };
    case "cancel_requested":
      return { ...base, reason: event.reason };
    case "attempt_stopped":
      return { ...base, attemptId: event.attemptId };
  }
}

function summarizeNodes(state: RunState): Record<string, NodeSummary> {
  const nodes: Record<string, NodeSummary> = {};
  for (const [nodeId, node] of Object.entries(state.nodes)) {
    nodes[nodeId] = {
      execution: node.execution,
      disposition: node.disposition,
      attemptCount: node.attemptCount,
      invalidatedAttemptCount: node.invalidatedAttemptCount,
      failureCategory: node.failureCategory,
    };
  }
  return nodes;
}

/** The example graph under a fresh run id, so every `run` journals a new run. */
function freshDemoGraph(): GraphSpec {
  return { ...demoGraphInput, runId: `demo-${randomUUID()}` };
}

/**
 * A new run crashes `implement`'s first attempt so the journal shows a retry under a new
 * fencing token. A resumed run gets a worker that only succeeds: whatever is still open after
 * the restart should finish.
 */
function ports(journal: FileJournalStore, resumed: boolean): HostPorts {
  const worker = resumed
    ? new ScriptedWorker()
    : new ScriptedWorker({ script: { implement: [{ type: "failed", category: "worker_crashed" }] } });
  return { journal, worker, gate: new ScriptedGate() };
}

/**
 * Runs the example graph end to end through `RunHost` with the scripted fake worker and gate,
 * journaling to a file, or resumes a run from its journal. Returns the process exit code.
 */
export async function runFakeRun(args: readonly string[]): Promise<number> {
  const parsed = parseRunArgs(args);
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error(RUN_USAGE);
    return 1;
  }
  const journalDir = resolve(parsed.options.journalDir);
  const journal = new FileJournalStore(journalDir);
  const resumed = parsed.options.resume !== null;

  const host =
    parsed.options.resume === null
      ? await RunHost.start(ports(journal, false), freshDemoGraph(), DEMO_POLICY)
      : await RunHost.resume(ports(journal, true), parsed.options.resume);
  const finalStatus = await host.completion;
  const stored = await journal.read(host.runId);
  const replayed = replay(stored.events);

  const output: FakeRunOutput = {
    mode: "fake-run",
    runId: host.runId,
    journal: journal.pathFor(host.runId),
    resumed,
    tornTail: host.recovery.tornTail,
    finalStatus,
    events: host.events.map(summarizeEvent),
    rejections: host.rejections.map((entry) => ({
      type: entry.event.type,
      code: entry.rejection.code,
      message: entry.rejection.message,
    })),
    nodes: summarizeNodes(host.state),
    replayMatches: canonicalJson(replayed.state) === canonicalJson(host.state) && replayed.rejections.length === 0,
  };
  console.log(JSON.stringify(output, null, 2));
  // 2: the journal does not replay to the live state; 1: the run ended failed or cancelled.
  if (!output.replayMatches) return 2;
  return finalStatus === "succeeded" ? 0 : 1;
}
