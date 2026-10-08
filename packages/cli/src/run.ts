import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import {
  type CheckReceipt,
  canonicalJson,
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  DEFAULT_CHECK_TIMEOUT_MS,
  type EvidenceStore,
  type ExecutionManifest,
  type GraphSpec,
  type JournalEvent,
  lintGraph,
  type ModelRoute,
  ModelRouteSchema,
  type ProjectConfig,
  parseDto,
  type RunPolicy,
  RunPolicySchema,
  type RunVerificationResult,
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
import { SessionWorker, WorkspaceVerifier } from "@auto-pi-lot/worker";

import { parseFlags, positiveInteger } from "./args.js";
import { EMPTY_CONFIG, loadConfig } from "./config.js";
import { demoGraphInput } from "./demo.js";
import { type AttemptEvidence, summarizeEvidence } from "./evidence-summary.js";
import { acquireRunLocks } from "./lock.js";
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
  "Usage: auto-pi-lot run [--graph <file> | --resume <runId>] [--worker fake|pi] [--workspace <dir>] [--config <file>] [--model <provider/id>] [--thinking off|low|medium|high] [--journal <dir>] [--max-concurrent <n>] [--max-attempts <n>] [--max-writers <n>] [--allow-warnings] [--quiet] [--dry-run]";

/** Where `run` journals by default, relative to the workspace: the gitignored local runtime directory. */
export const DEFAULT_JOURNAL_DIR = ".auto-pi-lot/journal";

/** Bounds the example run: two slots, and one retry per task so the scripted crash can be retried. */
const FAKE_POLICY: RunPolicy = { maxConcurrent: 2, maxAttemptsPerNode: 2 };
const PI_POLICY: RunPolicy = { maxConcurrent: 1, maxAttemptsPerNode: 2, maxConcurrentWriters: 1 };

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
  readonly dryRun: boolean;
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
const SWITCHES = ["--allow-warnings", "--quiet", "--dry-run"] as const;

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
  // Require an explicit worker selection and compare it with the journal before resuming.
  if (resume !== null && !values.has("--worker")) {
    return { ok: false, error: "--resume requires --worker fake or --worker pi, the kind the run was started with" };
  }
  if (resume !== null && values.has("--config")) {
    return { ok: false, error: "--resume uses the recorded execution manifest; --config cannot replace it" };
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
      dryRun: switches.has("--dry-run"),
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
  readonly verification: RunVerificationResult | null;
  readonly finalChecks: readonly CheckReceipt[];
  readonly execution: ExecutionManifest | null;
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
  let workspace = resolve(options.workspace ?? process.cwd());
  const workspaceProblem = await checkWorkspace(workspace);
  if (workspaceProblem !== null) {
    console.error(workspaceProblem);
    return 1;
  }
  workspace = await realpath(workspace);
  const canonicalProblem = await checkWorkspace(workspace);
  if (canonicalProblem !== null) {
    console.error(canonicalProblem);
    return 1;
  }
  const paths = runtimePaths(workspace, options.journalDir ?? undefined);
  const journalRelative = relative(workspace, paths.journal);
  if (
    usePi &&
    !isAbsolute(journalRelative) &&
    journalRelative !== ".." &&
    !journalRelative.startsWith(`..${sep}`) &&
    journalRelative !== ".auto-pi-lot" &&
    !journalRelative.startsWith(`.auto-pi-lot${sep}`)
  ) {
    console.error(
      "A Pi journal inside the workspace must be under .auto-pi-lot; use the default or a directory outside the workspace so journal writes do not change source fingerprints",
    );
    return 1;
  }
  const configFile = options.configFile === null ? paths.config : resolve(options.configFile);
  const loaded =
    options.resume === null
      ? await loadConfig(configFile, options.configFile !== null)
      : { ok: true as const, config: EMPTY_CONFIG };
  if (!loaded.ok) {
    console.error(loaded.error);
    return 2;
  }
  let { config } = loaded;
  const resumed = options.resume !== null;
  const journal = new FileJournalStore(paths.journal);

  let policy = mergePolicy(usePi ? PI_POLICY : FAKE_POLICY, config, options);
  if (policy === null) {
    console.error("The run policy from the configuration and flags is not valid");
    return 1;
  }
  if (usePi && !resumed) policy = { ...policy, requireFinalVerification: true };
  let execution: ExecutionManifest | undefined;
  let terminalResume = false;

  // The graph a pi run will execute, validated before any session can be opened.
  let graph: ValidatedGraph | null = null;
  if (options.graphFile !== null) {
    const plan = await loadPlan(options.graphFile);
    if (!plan.ok) return plan.code;
    graph = plan.graph;
  } else if (options.resume !== null) {
    const stored = await journal.read(options.resume);
    if (stored.events.length === 0) {
      console.error(`No journal found for run ${options.resume}`);
      return 1;
    }
    const replayed = replay(stored.events);
    if (replayed.rejections.length > 0 || replayed.state.graph === null || replayed.state.policy === null) {
      console.error("The journal does not replay cleanly; inspect the run before resuming");
      return 2;
    }
    terminalResume = ["succeeded", "failed", "cancelled"].includes(replayed.state.status);
    graph = replayed.state.graph;
    policy = replayed.state.policy;
    const first = stored.events[0];
    execution = first?.type === "run_started" ? first.execution : undefined;
    if (execution === undefined) {
      console.error("This legacy journal has no execution manifest; inspect it and start a new run with a fresh runId");
      return 1;
    }
    if (execution.worker !== options.worker) {
      console.error(
        `Run ${options.resume} was started with --worker ${execution.worker}; the worker kind cannot change on resume`,
      );
      return 1;
    }
    if (execution.workspace !== workspace) {
      console.error(`Run ${options.resume} belongs to workspace ${execution.workspace}; resume there`);
      return 1;
    }
    if (execution.worker === "pi") {
      if (
        (options.model !== null && canonicalJson(options.model) !== canonicalJson(execution.model)) ||
        (options.thinking !== null && options.thinking !== execution.thinkingLevel)
      ) {
        console.error("--resume cannot change the recorded model or thinking level; start a new run");
        return 1;
      }
      config = {
        schemaVersion: 1,
        checks: execution.checks,
        finalChecks: execution.finalCheckIds,
        model: execution.model,
        thinkingLevel: execution.thinkingLevel,
      };
    }
  } else {
    const demo = validateGraph(freshDemoGraph());
    if (!demo.ok) throw new Error("Internal error: invalid demo graph");
    graph = demo.graph;
  }

  // A run that left evidence on disk was a real run; the scripted gate must never decide it.
  if (!usePi && options.resume !== null && (await exists(join(paths.evidence, `run-${encodeRunId(options.resume)}`)))) {
    console.error(`Run ${options.resume} has recorded evidence; resume it with --worker pi`);
    return 1;
  }
  if (graph === null) throw new Error("Internal error: missing graph");
  if (!resumed && (await journal.read(graph.runId)).events.length > 0) {
    console.error(`Run ${graph.runId} already has a journal; use --resume or choose a new runId in the plan`);
    return 1;
  }
  if (usePi && policy.maxConcurrent !== 1) {
    console.error(
      "Pi runs share one mutable workspace and require --max-concurrent 1 so reviews and checks cannot overlap edits. Update the policy in auto-pi-lot.json; an older concurrent run cannot be resumed with Pi.",
    );
    return 1;
  }
  if (usePi && (policy.maxConcurrentWriters ?? 1) > 1) {
    console.error("Pi runs share one workspace and require --max-writers 1");
    return 1;
  }
  const unknownChecks = usePi ? validateGraphChecks(graph, config.checks) : [];
  if (unknownChecks.length > 0) {
    printIssues(options.graphFile ?? options.resume ?? "", unknownChecks);
    return 1;
  }
  const finalCheckIds =
    execution?.worker === "pi"
      ? execution.finalCheckIds
      : [...new Set([...graph.nodes.flatMap((node) => node.checks ?? []), ...(config.finalChecks ?? [])])].sort();
  const warnings = lintGraph(graph);
  if (usePi && !resumed && warnings.length > 0 && !options.allowWarnings) {
    console.log(JSON.stringify({ mode: "validate", file: options.graphFile, ok: true, warnings }, null, 2));
    console.error("Refusing to run a plan with lint warnings; fix them or pass --allow-warnings");
    return 1;
  }
  const locks = [join(paths.journal, ".writer.lock"), ...(usePi ? [join(workspace, ".auto-pi-lot", "run.lock")] : [])];
  for (const file of locks) {
    if (await exists(file)) {
      console.error(
        `Run lock exists at ${file}; another run may be active. Confirm its process and checks have stopped before removing a stale lock.`,
      );
      return 1;
    }
  }
  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          mode: "preflight",
          worker: options.worker,
          workspace,
          configFile,
          configurationSource: resumed ? "journal" : configFile,
          runId: graph.runId,
          resumed,
          journal: journal.pathFor(graph.runId),
          policy,
          model: options.model ?? config.model ?? null,
          thinkingLevel: options.thinking ?? config.thinkingLevel ?? (usePi ? "off" : null),
          finalCheckIds,
          modelReadiness: "not_checked",
          warnings,
          nodes: graph.nodes.map((node) => ({
            ...node,
            limits: { ...node.limits, timeoutMs: node.limits.timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS },
          })),
          edges: graph.edges,
          checks: config.checks
            .filter((profile) => finalCheckIds.includes(profile.id))
            .map((profile) => ({
              ...profile,
              cwd: resolve(workspace, profile.cwd ?? "."),
              timeoutMs: profile.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
            })),
          effects: usePi
            ? ["Edits the workspace in place", "Runs configured checks", "Uses model credit"]
            : ["Simulates outcomes; does not run checks or edit source"],
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const unlock = await acquireRunLocks(locks, workspace);
  let sessionWorker: SessionWorker | undefined;
  let verifier: WorkspaceVerifier | undefined;
  let host: RunHost | undefined;
  let interrupts = 0;
  const onSignal = (): void => {
    interrupts += 1;
    if (interrupts > 1) {
      // shutdown synchronously signals all running check groups before its first await.
      void sessionWorker?.shutdown();
      verifier?.cancel();
      process.exit(130); // Keep ownership files for explicit recovery after a forced exit.
    }
    console.error("cancelling…");
    host?.cancel("operator interrupt").catch(() => undefined);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
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
      const model = options.model ?? config.model;
      const thinkingLevel = options.thinking ?? config.thinkingLevel ?? "off";
      let opener: Awaited<ReturnType<typeof createPiSessionOpener>>;
      try {
        if (terminalResume && execution?.worker === "pi") {
          opener = Object.assign(
            async () => {
              throw new Error("A completed run cannot open a session");
            },
            { route: execution.model },
          );
        } else {
          opener = await createPiSessionOpener({
            ...(model === undefined ? {} : { model }),
            thinkingLevel,
          });
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
      route = opener.route;
      execution ??= {
        worker: "pi",
        workspace,
        model: route,
        thinkingLevel,
        checks: config.checks.map((profile) => ({
          ...profile,
          cwd: profile.cwd ?? ".",
          timeoutMs: profile.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
        })),
        finalCheckIds,
      };
      if (execution.worker === "pi") config = { ...config, checks: execution.checks };
      const worker = new SessionWorker({
        workspace,
        checks: config.checks,
        openSession: opener,
        evidence,
        artifacts: new FileArtifactStore(paths.artifacts),
        ...(log === undefined ? {} : { log }),
      });
      sessionWorker = worker;
      verifier = new WorkspaceVerifier({
        workspace,
        evidence,
        artifacts: new FileArtifactStore(paths.artifacts),
        checks: config.checks.filter((profile) => finalCheckIds.includes(profile.id)),
        ...(log === undefined ? {} : { log }),
      });
      ports = {
        journal,
        worker,
        verifier,
        gate: new EvidenceGate({ evidence }),
        ...(onEvent === undefined ? {} : { onEvent }),
      };
    } else {
      execution ??= { worker: "fake", workspace };
      // A new run of the example crashes `implement`'s first attempt so the journal shows a retry
      // under a new fencing token. A resumed run, or a run of a graph file, gets a worker that
      // only succeeds: whatever is still open after the restart should finish.
      const worker =
        options.graphFile === null && !resumed
          ? new ScriptedWorker({ script: { implement: [{ type: "failed", category: "worker_crashed" }] } })
          : new ScriptedWorker();
      ports = { journal, worker, gate: new ScriptedGate(), ...(onEvent === undefined ? {} : { onEvent }) };
    }

    if (interrupts > 0) return 130;
    try {
      if (options.resume !== null) host = await RunHost.resume(ports, options.resume);
      else host = await RunHost.start(ports, graph, policy, execution);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }

    if (interrupts > 0) await host.cancel("operator interrupt");
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

    const verification = host.state.verification;
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
      execution: execution ?? null,
      verification,
      finalChecks: records.filter(
        (record): record is CheckReceipt =>
          record.kind === "check" && (verification?.checkReceiptIds.includes(record.id) ?? false),
      ),
    };
    console.log(JSON.stringify(output, null, 2));
    // 2: the journal does not replay to the live state; 1: the run ended failed or cancelled.
    if (!output.replayMatches) return 2;
    return finalStatus === "succeeded" ? 0 : 1;
  } finally {
    try {
      await sessionWorker?.shutdown();
      await verifier?.shutdown();
      await unlock();
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }
}
