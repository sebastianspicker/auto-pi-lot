import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";

import {
  canonicalJson,
  type EvidenceStore,
  type GraphSpec,
  type JournalEvent,
  lintGraph,
  type ModelRoute,
  ModelRouteSchema,
  type ProjectConfig,
  parseDto,
  type RunPolicy,
  RunPolicySchema,
  replay,
  type ThinkingLevel,
  ThinkingLevelSchema,
  type ValidatedGraph,
  type ValidationIssue,
  validateGraph,
  validateGraphChecks,
} from "@auto-pi-lot/core";
import {
  EvidenceGate,
  encodeRunId,
  FileArtifactStore,
  FileEvidenceStore,
  FileJournalStore,
  type HostPorts,
  MemoryEvidenceStore,
  RunHost,
  ScriptedGate,
  ScriptedWorker,
} from "@auto-pi-lot/host";
import { createPiSessionOpener } from "@auto-pi-lot/pi";
import { SessionWorker } from "@auto-pi-lot/worker";

import { parseFlags, positiveInteger } from "./args.js";
import { loadConfig } from "./config.js";
import { demoGraphInput } from "./demo.js";
import { type AttemptEvidence, summarizeEvidence } from "./evidence-summary.js";
import { runtimePaths } from "./paths.js";
import {
  attemptNodes,
  type EventSummary,
  type NodeSummary,
  shortAttemptId,
  summarizeEvent,
  summarizeNodes,
} from "./summary.js";
import { printInvalidGraph, readJsonFile } from "./validate.js";

export const RUN_USAGE =
  "Usage: auto-pi-lot run [--graph <file> | --resume <runId>] [--worker fake|pi] [--workspace <dir>] [--config <file>] [--model <provider/id>] [--thinking off|low|medium|high] [--journal <dir>] [--max-concurrent <n>] [--max-attempts <n>] [--max-writers <n>] [--allow-warnings] [--quiet]";

/** Where `run` journals by default, relative to the workspace: the gitignored local runtime directory. */
export const DEFAULT_JOURNAL_DIR = ".auto-pi-lot/journal";

/** Bounds the example run: two slots, and one retry per task so the scripted crash can be retried. */
const FAKE_POLICY: RunPolicy = { maxConcurrent: 2, maxAttemptsPerNode: 2 };
const PI_POLICY: RunPolicy = { maxConcurrent: 2, maxAttemptsPerNode: 2, maxConcurrentWriters: 1 };

export interface RunOptions {
  readonly worker: "fake" | "pi";
  /** Whether `--worker` was given; a resume must say which worker kind it continues with. */
  readonly workerExplicit: boolean;
  readonly workspace: string | null;
  readonly configFile: string | null;
  readonly journalDir: string | null;
  readonly resume: string | null;
  readonly graphFile: string | null;
  readonly model: ModelRoute | null;
  readonly thinking: ThinkingLevel | null;
  readonly limits: {
    readonly maxConcurrent?: number;
    readonly maxAttemptsPerNode?: number;
    readonly maxConcurrentWriters?: number;
  };
  readonly allowWarnings: boolean;
  readonly quiet: boolean;
}

const VALUE_FLAGS = [
  "--journal",
  "--resume",
  "--graph",
  "--max-concurrent",
  "--max-attempts",
  "--max-writers",
  "--worker",
  "--workspace",
  "--config",
  "--model",
  "--thinking",
] as const;
const SWITCHES = ["--allow-warnings", "--quiet"] as const;

/** Parses `run`'s arguments; never throws, so the entry point can print the usage line. */
export function parseRunArgs(
  args: readonly string[],
): { ok: true; options: RunOptions } | { ok: false; error: string } {
  const parsed = parseFlags(args, { values: VALUE_FLAGS, switches: SWITCHES });
  if (!parsed.ok) return parsed;
  const { values, switches } = parsed.flags;

  const worker = values.get("--worker") ?? "fake";
  if (worker !== "fake" && worker !== "pi") return { ok: false, error: `Unknown worker: ${worker} (use fake or pi)` };
  const resume = values.get("--resume") ?? null;
  const graphFile = values.get("--graph") ?? null;
  if (resume !== null && graphFile !== null) return { ok: false, error: "--graph cannot be combined with --resume" };
  // The journal does not record which worker kind started a run, and resuming a real run with the
  // scripted gate would journal fabricated acceptances, so a resume must name its worker.
  if (resume !== null && !values.has("--worker")) {
    return { ok: false, error: "--resume requires --worker fake or --worker pi, the kind the run was started with" };
  }
  if (worker === "pi" && resume === null && graphFile === null) {
    return { ok: false, error: "--worker pi requires --graph <file> or --resume <runId>" };
  }
  // A resumed run keeps the policy its journal recorded; a limit flag would be silently ignored.
  if (
    resume !== null &&
    (values.has("--max-concurrent") || values.has("--max-attempts") || values.has("--max-writers"))
  ) {
    return { ok: false, error: "--max-concurrent, --max-attempts and --max-writers cannot be combined with --resume" };
  }

  const limits: { maxConcurrent?: number; maxAttemptsPerNode?: number; maxConcurrentWriters?: number } = {};
  for (const [flag, key] of [
    ["--max-concurrent", "maxConcurrent"],
    ["--max-attempts", "maxAttemptsPerNode"],
    ["--max-writers", "maxConcurrentWriters"],
  ] as const) {
    const raw = values.get(flag);
    if (raw === undefined) continue;
    const number = positiveInteger(raw);
    if (number === null) return { ok: false, error: `Unknown or incomplete argument: ${flag}` };
    limits[key] = number;
  }

  let model: ModelRoute | null = null;
  const rawModel = values.get("--model");
  if (rawModel !== undefined) {
    const slash = rawModel.indexOf("/");
    const route = parseDto(ModelRouteSchema, {
      provider: slash < 0 ? "" : rawModel.slice(0, slash),
      id: slash < 0 ? "" : rawModel.slice(slash + 1),
    });
    if (!route.ok) return { ok: false, error: `--model must be <provider>/<id>, got: ${rawModel}` };
    model = route.value;
  }

  let thinking: ThinkingLevel | null = null;
  const rawThinking = values.get("--thinking");
  if (rawThinking !== undefined) {
    const level = parseDto(ThinkingLevelSchema, rawThinking);
    if (!level.ok) return { ok: false, error: `--thinking must be off, low, medium or high, got: ${rawThinking}` };
    thinking = level.value;
  }

  return {
    ok: true,
    options: {
      worker,
      workerExplicit: values.has("--worker"),
      workspace: values.get("--workspace") ?? null,
      configFile: values.get("--config") ?? null,
      journalDir: values.get("--journal") ?? null,
      resume,
      graphFile,
      model,
      thinking,
      limits,
      allowWarnings: switches.has("--allow-warnings"),
      quiet: switches.has("--quiet"),
    },
  };
}

export interface RunOutput {
  readonly mode: "run";
  readonly worker: "fake" | "pi";
  readonly route?: ModelRoute;
  readonly workspace?: string;
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
  /** Per node: the evidence recorded for each of its attempts (empty for the fake worker). */
  readonly evidence: Readonly<Record<string, readonly AttemptEvidence[]>>;
  /** Replaying the journal reproduces the live state; false would be a reducer or store bug. */
  readonly replayMatches: boolean;
}

/** The example graph under a fresh run id, so every `run` journals a new run. */
function freshDemoGraph(): GraphSpec {
  return { ...demoGraphInput, runId: `demo-${randomUUID()}` };
}

function mergePolicy(defaults: RunPolicy, config: ProjectConfig, options: RunOptions): RunPolicy | null {
  const merged = { ...defaults, ...(config.policy ?? {}), ...options.limits };
  const parsed = parseDto(RunPolicySchema, merged);
  return parsed.ok ? parsed.value : null;
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}

function clockTime(date: Date): string {
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** One progress line per applied event, for stderr. */
function progressLine(event: JournalEvent, index: number, nodeOfAttempt: Map<string, string>): string {
  const summary = summarizeEvent(event, index);
  if (event.type === "attempt_dispatched") nodeOfAttempt.set(event.attemptId, event.nodeId);
  const nodeId = summary.nodeId ?? (summary.attemptId === undefined ? undefined : nodeOfAttempt.get(summary.attemptId));
  const parts = [clockTime(new Date(event.at)), event.type];
  if (nodeId !== undefined) parts.push(`node=${nodeId}`);
  if (summary.attemptId !== undefined) parts.push(`attempt=${shortAttemptId(summary.attemptId)}`);
  if (summary.decision !== undefined) parts.push(`decision=${summary.decision}`);
  if (summary.category !== undefined) parts.push(`category=${summary.category}`);
  if (summary.reason !== undefined) parts.push(`reason=${summary.reason}`);
  return parts.join(" ");
}

function printIssues(file: string, issues: readonly ValidationIssue[]): void {
  printInvalidGraph(file, issues);
}

/** Control characters other than newline and tab are shown escaped, so a log line cannot drive the terminal. */
export function sanitizeLine(line: string): string {
  let out = "";
  for (const char of line) {
    const code = char.codePointAt(0) ?? 0;
    const control = (code < 0x20 && code !== 0x0a && code !== 0x09) || (code >= 0x7f && code <= 0x9f);
    out += control ? `\\x${code.toString(16).padStart(2, "0")}` : char;
  }
  return out;
}

/** A workspace must be a directory, and never the file system root or the home directory. */
export async function checkWorkspace(workspace: string): Promise<string | null> {
  if (workspace === parse(workspace).root || workspace === resolve(homedir())) {
    return `Refusing to use ${workspace} as the workspace; run inside a project directory`;
  }
  try {
    if (!(await lstat(workspace)).isDirectory()) return `${workspace} is not a directory`;
  } catch {
    return `${workspace} does not exist`;
  }
  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Reads a plan file and validates it; prints the problem and returns the exit code on failure. */
async function loadPlan(file: string): Promise<{ ok: true; graph: ValidatedGraph } | { ok: false; code: number }> {
  const read = await readJsonFile(file);
  if (!read.ok) {
    console.error(read.error);
    console.error(RUN_USAGE);
    return { ok: false, code: 2 };
  }
  const validated = validateGraph(read.value);
  if (!validated.ok) {
    printIssues(file, validated.issues);
    return { ok: false, code: 1 };
  }
  return { ok: true, graph: validated.graph };
}

/**
 * Runs the example graph, or a graph file, end to end through `RunHost`, or resumes a run from
 * its journal. The worker is the scripted fake by default, or Pi sessions with `--worker pi`.
 * Returns the process exit code.
 */
export async function runRun(args: readonly string[]): Promise<number> {
  const parsed = parseRunArgs(args);
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error(RUN_USAGE);
    return 1;
  }
  const { options } = parsed;
  const usePi = options.worker === "pi";
  const workspace = resolve(options.workspace ?? process.cwd());
  const workspaceProblem = await checkWorkspace(workspace);
  if (workspaceProblem !== null) {
    console.error(workspaceProblem);
    return 1;
  }
  const paths = runtimePaths(workspace, options.journalDir ?? undefined);
  const configFile = options.configFile === null ? paths.config : resolve(options.configFile);
  const loaded = await loadConfig(configFile, options.configFile !== null);
  if (!loaded.ok) {
    console.error(loaded.error);
    return 2;
  }
  const { config } = loaded;
  const resumed = options.resume !== null;
  const journal = new FileJournalStore(paths.journal);

  const policy = mergePolicy(usePi ? PI_POLICY : FAKE_POLICY, config, options);
  if (policy === null) {
    console.error("The run policy from the configuration and flags is not valid");
    return 1;
  }

  // The graph a pi run will execute, validated before any session can be opened.
  let graph: ValidatedGraph | null = null;
  if (options.graphFile !== null) {
    const plan = await loadPlan(options.graphFile);
    if (!plan.ok) return plan.code;
    graph = plan.graph;
  } else if (options.resume !== null && usePi) {
    const stored = await journal.read(options.resume);
    if (stored.events.length === 0) {
      console.error(`No journal found for run ${options.resume}`);
      return 1;
    }
    graph = replay(stored.events).state.graph;
  }

  // A run that left evidence on disk was a real run; the scripted gate must never decide it.
  if (!usePi && options.resume !== null && (await exists(join(paths.evidence, `run-${encodeRunId(options.resume)}`)))) {
    console.error(`Run ${options.resume} has recorded evidence; resume it with --worker pi`);
    return 1;
  }
  const evidence: EvidenceStore = usePi ? new FileEvidenceStore(paths.evidence) : new MemoryEvidenceStore();
  const nodeOfAttempt = new Map<string, string>();
  let eventCount = 0;
  const onEvent = options.quiet
    ? undefined
    : (event: JournalEvent): void => {
        eventCount += 1;
        console.error(progressLine(event, eventCount - 1, nodeOfAttempt));
      };
  const log = options.quiet
    ? undefined
    : (line: string): void => console.error(`${clockTime(new Date())} worker: ${sanitizeLine(line)}`);

  let ports: HostPorts;
  let route: ModelRoute | undefined;
  if (usePi) {
    if (graph !== null) {
      const unknownChecks = validateGraphChecks(graph, config.checks);
      if (unknownChecks.length > 0) {
        printIssues(options.graphFile ?? options.resume ?? "", unknownChecks);
        return 1;
      }
      if (options.graphFile !== null) {
        const warnings = lintGraph(graph);
        if (warnings.length > 0 && !options.allowWarnings) {
          console.log(
            JSON.stringify(
              {
                mode: "validate",
                file: options.graphFile,
                ok: true,
                warnings: warnings.map((w) => ({ code: w.code, path: w.path, message: w.message })),
              },
              null,
              2,
            ),
          );
          console.error("Refusing to run a plan with lint warnings; fix them or pass --allow-warnings");
          return 1;
        }
      }
    }
    const model = options.model ?? config.model;
    const thinkingLevel = options.thinking ?? config.thinkingLevel;
    let opener: Awaited<ReturnType<typeof createPiSessionOpener>>;
    try {
      opener = await createPiSessionOpener({
        ...(model === undefined ? {} : { model }),
        ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
    route = opener.route;
    const worker = new SessionWorker({
      workspace,
      checks: config.checks,
      openSession: opener,
      evidence,
      artifacts: new FileArtifactStore(paths.artifacts),
      ...(log === undefined ? {} : { log }),
    });
    ports = { journal, worker, gate: new EvidenceGate({ evidence }), ...(onEvent === undefined ? {} : { onEvent }) };
  } else {
    // A new run of the example crashes `implement`'s first attempt so the journal shows a retry
    // under a new fencing token. A resumed run, or a run of a graph file, gets a worker that
    // only succeeds: whatever is still open after the restart should finish.
    const worker =
      options.graphFile === null && !resumed
        ? new ScriptedWorker({ script: { implement: [{ type: "failed", category: "worker_crashed" }] } })
        : new ScriptedWorker();
    ports = { journal, worker, gate: new ScriptedGate(), ...(onEvent === undefined ? {} : { onEvent }) };
  }

  let host: RunHost;
  try {
    if (options.resume !== null) host = await RunHost.resume(ports, options.resume);
    else host = await RunHost.start(ports, graph ?? freshDemoGraph(), policy);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  // Registered only while the run is in flight: the first interrupt cancels, the second exits.
  let interrupts = 0;
  const onSigint = (): void => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    console.error("cancelling…");
    host.cancel("operator interrupt").catch(() => undefined);
  };
  process.on("SIGINT", onSigint);
  let finalStatus: RunOutput["finalStatus"];
  try {
    finalStatus = await host.completion;
  } catch (error) {
    // The host stopped (a store or gate failure). It has no authority left over the attempts it
    // started, so the composition root stops them: nothing should keep editing the workspace.
    for (const [attemptId, attempt] of Object.entries(host.state.attempts)) {
      if (attempt.status === "dispatched" || attempt.status === "stopping") ports.worker.cancel(attemptId);
    }
    console.error(`The host stopped: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
  }

  const stored = await journal.read(host.runId);
  const replayed = replay(stored.events);
  let records: Awaited<ReturnType<EvidenceStore["listForRun"]>>;
  try {
    records = await evidence.listForRun(host.runId);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const output: RunOutput = {
    mode: "run",
    worker: options.worker,
    ...(route === undefined ? {} : { route, workspace }),
    runId: host.runId,
    journal: journal.pathFor(host.runId),
    resumed,
    graphFile: options.graphFile,
    tornTail: host.recovery.tornTail,
    finalStatus,
    events: host.events.map(summarizeEvent),
    rejections: host.rejections.map((entry) => ({
      type: entry.event.type,
      code: entry.rejection.code,
      message: entry.rejection.message,
    })),
    nodes: summarizeNodes(host.state),
    evidence: summarizeEvidence(records, {
      nodeIds: Object.keys(host.state.nodes),
      attemptNodes: attemptNodes(host.state),
    }),
    replayMatches: canonicalJson(replayed.state) === canonicalJson(host.state) && replayed.rejections.length === 0,
  };
  console.log(JSON.stringify(output, null, 2));
  // 2: the journal does not replay to the live state; 1: the run ended failed or cancelled.
  if (!output.replayMatches) return 2;
  return finalStatus === "succeeded" ? 0 : 1;
}
