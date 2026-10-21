import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export const GRAPH_USAGE = [
  "auto-pi-lot graph mode, driven through the auto-pi-lot command-line tool:",
  "  /graph run <plan file> [--run-id <id>]  start a run with real Pi sessions (spends model credit)",
  "  /graph resume <runId>                   resume an interrupted run",
  "  /graph cancel                           cancel the run started from this Pi session",
  "  /graph status                           list runs in this repository",
  "  /graph inspect <runId>                  summarise one run",
  "  /graph on|off|pause                     not available yet (needs the background supervisor)",
  "Plan files and run IDs may not contain spaces. Set up a plan first with `auto-pi-lot init`.",
].join("\n");

const SUPERVISOR_MESSAGE =
  "/graph on, off and pause need the background supervisor, which is not part of this alpha. Use /graph run, /graph cancel and /graph resume instead.";
const WIDGET_KEY = "auto-pi-lot";
const WIDGET_LINES = 8;
/** Longest stderr tail kept for an error notice, in characters. */
const STDERR_TAIL_CHARS = 2000;

/** The part of a child process the extension uses. */
export interface GraphChild {
  /** Set once the process has started; an `error` without it means the spawn failed. */
  readonly pid?: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface GraphSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export type GraphSpawn = (command: string, args: readonly string[], options: GraphSpawnOptions) => GraphChild;

export interface GraphCommandDeps {
  /** Starts a child process. Defaults to `node:child_process` `spawn` without a shell. */
  readonly spawn?: GraphSpawn;
  /** Returns the path of the CLI entry point. Defaults to `AUTO_PI_LOT_CLI`, else the sibling package build. */
  readonly cliPath?: () => string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface GraphCommand {
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
  /** Sends SIGINT to the active run, if any. */
  shutdown(): void;
}

const defaultSpawn: GraphSpawn = (command, args, options) =>
  spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

const hasControlCharacter = (value: string): boolean => {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/** A plan path or run ID that is safe to hand to the CLI as one argument. */
function checkArgument(label: string, value: string): string | null {
  if (hasControlCharacter(value)) return `${label} contains control characters`;
  if (value.startsWith("-")) return `${label} must not start with "-"`;
  return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseJson(source: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(source);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

const text = (value: unknown): string => (typeof value === "string" ? value : "?");

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

type Notify = ExtensionCommandContext["ui"]["notify"];

/** Builds the `/graph` handler. Dependencies are injectable so tests never start a real process. */
export function createGraphCommand(deps: GraphCommandDeps = {}): GraphCommand {
  const startChild = deps.spawn ?? defaultSpawn;
  const env = deps.env ?? process.env;
  const cliPath =
    deps.cliPath ?? (() => env.AUTO_PI_LOT_CLI ?? fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url)));
  let active: { readonly child: GraphChild; readonly label: string; interrupted: boolean } | null = null;

  /** One SIGINT per run: the CLI treats a second one as a forced exit that keeps its lock files. */
  function interrupt(): boolean {
    if (active === null || active.interrupted) return false;
    active.interrupted = true;
    active.child.kill("SIGINT");
    return true;
  }

  /** Resolves the CLI path or tells the user why it is missing. */
  function resolveCli(notify: Notify): string | null {
    const path = cliPath();
    if (existsSync(path)) return path;
    notify(`auto-pi-lot CLI not found at ${path}. Run npm run build, or set AUTO_PI_LOT_CLI to its index.js.`, "error");
    return null;
  }

  /** Runs a short read-only CLI command to completion. */
  function runToCompletion(cli: string, args: readonly string[], cwd: string): Promise<CliResult> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: CliResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const child = startChild(process.execPath, [cli, ...args], { cwd, env });
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => finish({ code: null, stdout, stderr: `${stderr}${error.message}` }));
      child.on("close", (code) => finish({ code, stdout, stderr }));
    });
  }

  function start(ctx: ExtensionCommandContext, cliArgs: readonly string[], label: string): void {
    // Pi's `ctx.ui` getter throws once the session is replaced or shut down, and the child's
    // events arrive later: capture the UI now, and never let a UI call throw from a listener.
    const ui = ctx.ui;
    const { notify } = ui;
    const show = (call: () => void): void => {
      try {
        call();
      } catch {
        // The Pi session that started the run is gone; the run itself carries on.
      }
    };
    if (active !== null) {
      notify(`A graph run is already active (${active.label}). Use /graph cancel first.`, "warning");
      return;
    }
    const cli = resolveCli(notify);
    if (cli === null) return;
    const child = startChild(process.execPath, [cli, ...cliArgs], { cwd: ctx.cwd, env });
    active = { child, label, interrupted: false };
    ui.setStatus(WIDGET_KEY, `graph: running ${label}`);

    let stdout = "";
    let stderr = "";
    let pending = "";
    const recent: string[] = [];
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const data = chunk.toString();
      stderr = (stderr + data).slice(-STDERR_TAIL_CHARS);
      const lines = (pending + data).split(/\r?\n/);
      pending = lines.pop() ?? "";
      const complete = lines.filter((line) => line.length > 0);
      if (complete.length === 0) return;
      recent.push(...complete);
      recent.splice(0, Math.max(0, recent.length - WIDGET_LINES));
      show(() => ui.setWidget(WIDGET_KEY, [...recent]));
    });

    let finished = false;
    const finish = (code: number | null, failure: string | null) => {
      if (finished) return;
      finished = true;
      if (active?.child === child) active = null;
      show(() => ui.setWidget(WIDGET_KEY, undefined));
      show(() => ui.setStatus(WIDGET_KEY, undefined));
      if (failure !== null) {
        show(() => notify(`graph run ${label} could not run: ${failure}`, "error"));
        return;
      }
      const report = parseJson(stdout);
      const level = code === 0 ? "info" : "error";
      if (report === null) {
        const tail = stderr.trim();
        show(() => notify(`graph run ${label} exited with code ${code ?? "none"}${tail ? `:\n${tail}` : ""}`, level));
        return;
      }
      const sessions = typeof report.sessions === "string" ? `, sessions: ${report.sessions}` : "";
      show(() =>
        notify(
          `graph run ${text(report.runId)}: ${text(report.finalStatus)} (exit ${code ?? "none"})${sessions}`,
          level,
        ),
      );
    };
    child.on("error", (error) => {
      // Before the process started, an error means it never will; afterwards (a failed signal,
      // say) the process may still be running, and its `close` event ends the run.
      if (child.pid === undefined) finish(null, error.message);
      else show(() => notify(`graph run ${label}: ${error.message}`, "warning"));
    });
    child.on("close", (code) => finish(code, null));
  }

  async function status(ctx: ExtensionCommandContext): Promise<void> {
    const { notify } = ctx.ui;
    const cli = resolveCli(notify);
    if (cli === null) return;
    const result = await runToCompletion(cli, ["status"], ctx.cwd);
    const report = parseJson(result.stdout);
    const runs = report !== null && Array.isArray(report.runs) ? report.runs : null;
    if (result.code !== 0 || runs === null) {
      notify(
        `graph status failed (exit ${result.code ?? "none"}): ${result.stderr.trim() || result.stdout.trim()}`,
        "error",
      );
      return;
    }
    const lines = runs.map((run) =>
      isRecord(run)
        ? `${text(run.runId)}: ${"error" in run ? `unreadable (${text(run.error)})` : text(run.status)}`
        : "?",
    );
    const own = active === null ? "no run active in this Pi session" : `run active in this Pi session: ${active.label}`;
    notify([...(lines.length > 0 ? lines : ["no runs found"]), own].join("\n"), "info");
  }

  async function inspect(ctx: ExtensionCommandContext, runId: string): Promise<void> {
    const { notify } = ctx.ui;
    const cli = resolveCli(notify);
    if (cli === null) return;
    const result = await runToCompletion(cli, ["inspect", runId], ctx.cwd);
    const report = parseJson(result.stdout);
    if (result.code !== 0 || report === null) {
      notify(
        `graph inspect failed (exit ${result.code ?? "none"}): ${result.stderr.trim() || result.stdout.trim()}`,
        "error",
      );
      return;
    }
    const lines = [`run ${text(report.runId)}: ${text(report.status)}`];
    if (isRecord(report.nodes)) {
      for (const [nodeId, node] of Object.entries(report.nodes)) {
        lines.push(`  ${nodeId}: ${isRecord(node) ? text(node.disposition) : "?"}`);
      }
    }
    if (typeof report.sessions === "string") lines.push(`sessions: ${report.sessions}`);
    if (isRecord(report.verification)) lines.push(`verification: ${text(report.verification.outcome)}`);
    notify(lines.join("\n"), "info");
  }

  async function handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const { notify } = ctx.ui;
    const [subcommand, ...rest] = args
      .trim()
      .split(/\s+/)
      .filter((part) => part.length > 0);
    const reject = (reason: string) => notify(`${reason}\n${GRAPH_USAGE}`, "warning");
    switch (subcommand) {
      case undefined:
      case "help":
        notify(GRAPH_USAGE, "info");
        return;
      case "on":
      case "off":
      case "pause":
        notify(SUPERVISOR_MESSAGE, "warning");
        return;
      case "run": {
        const [plan, ...options] = rest;
        if (plan === undefined) return reject("/graph run needs a plan file.");
        const planError = checkArgument("plan file", plan);
        if (planError !== null) return reject(planError);
        const cliArgs = ["run", "--worker", "pi", "--graph", plan];
        let runId: string | undefined;
        if (options.length > 0) {
          const [flag, value, ...extra] = options;
          if (flag !== "--run-id" || value === undefined || extra.length > 0) {
            return reject("/graph run takes only <plan file> [--run-id <id>].");
          }
          const idError = checkArgument("run ID", value);
          if (idError !== null) return reject(idError);
          runId = value;
          cliArgs.push("--run-id", value);
        }
        start(ctx, cliArgs, runId ?? plan);
        return;
      }
      case "resume": {
        const [runId, ...extra] = rest;
        if (runId === undefined || extra.length > 0) return reject("/graph resume needs exactly one run ID.");
        const idError = checkArgument("run ID", runId);
        if (idError !== null) return reject(idError);
        start(ctx, ["run", "--worker", "pi", "--resume", runId], runId);
        return;
      }
      case "cancel":
        if (active === null) {
          notify("No graph run is active in this Pi session.", "info");
          return;
        }
        if (!interrupt()) {
          notify(`Already cancelling graph run ${active.label}; waiting for it to stop.`, "info");
          return;
        }
        notify(`Cancelling graph run ${active.label}; waiting for it to stop.`, "info");
        return;
      case "status":
        await status(ctx);
        return;
      case "inspect": {
        const [runId, ...extra] = rest;
        if (runId === undefined || extra.length > 0) return reject("/graph inspect needs exactly one run ID.");
        const idError = checkArgument("run ID", runId);
        if (idError !== null) return reject(idError);
        await inspect(ctx, runId);
        return;
      }
      default:
        return reject(`Unknown /graph subcommand: ${subcommand}.`);
    }
  }

  return {
    handler,
    shutdown: () => {
      interrupt();
    },
  };
}

/** Entry point. `/graph` starts, follows, cancels and inspects runs by driving the auto-pi-lot CLI as a child process. */
export default function autoPiLot(pi: ExtensionAPI): void {
  const graph = createGraphCommand();
  pi.registerCommand("graph", {
    description: "Start, follow, cancel and inspect auto-pi-lot graph runs",
    handler: graph.handler,
  });
  pi.on("session_shutdown", () => {
    graph.shutdown();
  });
}
