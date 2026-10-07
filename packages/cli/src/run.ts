import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  canonicalJson,
  type ExecutionState,
  type FailureCategory,
  type GraphSpec,
  type JournalEvent,
  parseDto,
  type ResultDisposition,
  type RunPolicy,
  RunPolicySchema,
  type RunState,
  replay,
  validateGraph,
} from "@auto-pi-lot/core";
import { FileJournalStore, type HostPorts, RunHost, ScriptedGate, ScriptedWorker } from "@auto-pi-lot/host";

import { demoGraphInput } from "./demo.js";
import { printInvalidGraph, readJsonFile } from "./validate.js";

export const RUN_USAGE =
  "Usage: auto-pi-lot run [--journal <dir>] [--resume <runId> | --graph <file>] [--max-concurrent <n>] [--max-attempts <n>]";

/** Where `run` journals by default: the gitignored local runtime directory. */
export const DEFAULT_JOURNAL_DIR = ".auto-pi-lot/journal";

/** Bounds the example run: two slots, and one retry per task so the scripted crash can be retried. */
const DEMO_POLICY: RunPolicy = { maxConcurrent: 2, maxAttemptsPerNode: 2 };

export interface RunOptions {
  readonly journalDir: string;
  readonly resume: string | null;
  readonly graphFile: string | null;
  readonly policy: RunPolicy;
}

/** Every flag takes one value; `--max-*` values must be positive integers. */
const RUN_FLAGS = ["--journal", "--resume", "--graph", "--max-concurrent", "--max-attempts"] as const;
type RunFlag = (typeof RUN_FLAGS)[number];

function isRunFlag(arg: string | undefined): arg is RunFlag {
  return RUN_FLAGS.some((flag) => flag === arg);
}

function positiveInteger(value: string): number | null {
  const number = /^[1-9][0-9]*$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(number) ? number : null;
}

/** Parses `run`'s arguments; never throws, so the entry point can print the usage line. */
export function parseRunArgs(
  args: readonly string[],
): { ok: true; options: RunOptions } | { ok: false; error: string } {
  const values = new Map<RunFlag, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (!isRunFlag(arg)) {
      return { ok: false, error: `Unknown or incomplete argument: ${String(arg)}` };
    }
    // A missing, empty or flag-like value is an incomplete argument.
    if (value === undefined || value === "" || value.startsWith("--")) {
      return { ok: false, error: `Unknown or incomplete argument: ${arg}` };
    }
    if (values.has(arg)) return { ok: false, error: `${arg} given twice` };
    values.set(arg, value);
    index += 1;
  }

  const resume = values.get("--resume") ?? null;
  const graphFile = values.get("--graph") ?? null;
  if (resume !== null && graphFile !== null) return { ok: false, error: "--graph cannot be combined with --resume" };
  // A resumed run keeps the policy its journal recorded; a limit flag would be silently ignored.
  if (resume !== null && (values.has("--max-concurrent") || values.has("--max-attempts"))) {
    return { ok: false, error: "--max-concurrent and --max-attempts cannot be combined with --resume" };
  }

  const maxConcurrent = positiveInteger(values.get("--max-concurrent") ?? String(DEMO_POLICY.maxConcurrent));
  const maxAttempts = positiveInteger(values.get("--max-attempts") ?? String(DEMO_POLICY.maxAttemptsPerNode));
  const policy = parseDto(RunPolicySchema, { maxConcurrent, maxAttemptsPerNode: maxAttempts });
  if (!policy.ok) {
    const flag = maxConcurrent === null ? "--max-concurrent" : "--max-attempts";
    return { ok: false, error: `Unknown or incomplete argument: ${flag}` };
  }
  return {
    ok: true,
    options: { journalDir: values.get("--journal") ?? DEFAULT_JOURNAL_DIR, resume, graphFile, policy: policy.value },
  };
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
  /** The graph file the run was started from, or null for the built-in example. */
  readonly graphFile: string | null;
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

/** Built from entries so a node id such as `__proto__` becomes an own key, never a prototype write. */
function summarizeNodes(state: RunState): Record<string, NodeSummary> {
  return Object.fromEntries(
    Object.entries(state.nodes).map(([nodeId, node]): [string, NodeSummary] => [
      nodeId,
      {
        execution: node.execution,
        disposition: node.disposition,
        attemptCount: node.attemptCount,
        invalidatedAttemptCount: node.invalidatedAttemptCount,
        failureCategory: node.failureCategory,
      },
    ]),
  );
}

/** The example graph under a fresh run id, so every `run` journals a new run. */
function freshDemoGraph(): GraphSpec {
  return { ...demoGraphInput, runId: `demo-${randomUUID()}` };
}

/**
 * A new run of the example crashes `implement`'s first attempt so the journal shows a retry
 * under a new fencing token. A resumed run, or a run of a graph file, gets a worker that only
 * succeeds: whatever is still open after the restart should finish.
 */
function ports(journal: FileJournalStore, scriptedCrash: boolean): HostPorts {
  const worker = scriptedCrash
    ? new ScriptedWorker({ script: { implement: [{ type: "failed", category: "worker_crashed" }] } })
    : new ScriptedWorker();
  return { journal, worker, gate: new ScriptedGate() };
}

/**
 * Runs the example graph, or a graph file, end to end through `RunHost` with the scripted fake
 * worker and gate, journaling to a file, or resumes a run from its journal. Returns the process
 * exit code.
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

  const { graphFile, policy } = parsed.options;

  let host: RunHost;
  if (parsed.options.resume !== null) {
    host = await RunHost.resume(ports(journal, false), parsed.options.resume);
  } else if (graphFile === null) {
    host = await RunHost.start(ports(journal, true), freshDemoGraph(), policy);
  } else {
    const read = await readJsonFile(graphFile);
    if (!read.ok) {
      console.error(read.error);
      console.error(RUN_USAGE);
      return 2;
    }
    const validated = validateGraph(read.value);
    if (!validated.ok) {
      printInvalidGraph(graphFile, validated.issues);
      return 1;
    }
    try {
      host = await RunHost.start(ports(journal, false), validated.graph, policy);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  const finalStatus = await host.completion;
  const stored = await journal.read(host.runId);
  const replayed = replay(stored.events);

  const output: FakeRunOutput = {
    mode: "fake-run",
    runId: host.runId,
    journal: journal.pathFor(host.runId),
    resumed,
    graphFile,
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
