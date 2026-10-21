import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import autoPiLot, {
  createGraphCommand,
  GRAPH_USAGE,
  type GraphChild,
  type GraphSpawnOptions,
} from "../src/extension.js";

interface RegisteredCommand {
  description?: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

/** Records only the members the extension touches; everything else stays unimplemented. */
function createFakeApi() {
  const commands = new Map<string, RegisteredCommand>();
  const listeners = new Map<string, () => void>();
  const api = {
    registerCommand: (name: string, command: RegisteredCommand) => {
      commands.set(name, command);
    },
    on: (event: string, listener: () => void) => {
      listeners.set(event, listener);
    },
  } as unknown as ExtensionAPI;
  return { api, commands, listeners };
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: Array<NodeJS.Signals | undefined> = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }
  /** Ends the streams, then reports the exit, as a real process would. */
  exit(code: number | null, stdout = ""): void {
    if (stdout) this.stdout.write(stdout);
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, null);
  }
}

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: GraphSpawnOptions;
  child: FakeChild;
}

const CLI = fileURLToPath(import.meta.url);

function setup(cliPath: () => string = () => CLI) {
  const calls: SpawnCall[] = [];
  const notices: Array<{ message: string; level: string }> = [];
  const widgets: Array<string[] | undefined> = [];
  const statuses: Array<string | undefined> = [];
  const graph = createGraphCommand({
    cliPath,
    env: { PATH: "fake" },
    spawn: (command, args, options) => {
      const child = new FakeChild();
      calls.push({ command, args, options, child });
      return child as unknown as GraphChild;
    },
  });
  const ctx = {
    cwd: "/work/repo",
    ui: {
      notify: (message: string, level: string) => notices.push({ message, level }),
      setWidget: (_key: string, content: string[] | undefined) => widgets.push(content),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
    },
  } as unknown as ExtensionCommandContext;
  return { graph, calls, notices, widgets, statuses, ctx };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("the extension registers /graph and a shutdown listener", () => {
  const { api, commands, listeners } = createFakeApi();
  autoPiLot(api);
  assert.deepEqual([...commands.keys()], ["graph"]);
  assert.equal(commands.get("graph")?.description, "Start, follow, cancel and inspect auto-pi-lot graph runs");
  assert.deepEqual([...listeners.keys()], ["session_shutdown"]);
});

test("/graph with no arguments or help prints the usage", async () => {
  const { graph, calls, notices, ctx } = setup();
  await graph.handler("", ctx);
  await graph.handler("help", ctx);
  assert.deepEqual(
    notices,
    [GRAPH_USAGE, GRAPH_USAGE].map((message) => ({ message, level: "info" })),
  );
  assert.match(GRAPH_USAGE, /\/graph run <plan file>/);
  assert.equal(calls.length, 0);
});

test("an unknown subcommand prints the usage as a warning", async () => {
  const { graph, calls, notices, ctx } = setup();
  await graph.handler("frobnicate", ctx);
  assert.equal(notices[0]?.level, "warning");
  assert.match(notices[0]?.message ?? "", /Unknown \/graph subcommand: frobnicate/);
  assert.match(notices[0]?.message ?? "", /\/graph status/);
  assert.equal(calls.length, 0);
});

test("on, off and pause say the supervisor is not available and spawn nothing", async () => {
  const { graph, calls, notices, ctx } = setup();
  for (const sub of ["on", "off", "pause"]) await graph.handler(sub, ctx);
  assert.equal(notices.length, 3);
  for (const notice of notices) {
    assert.equal(notice.level, "warning");
    assert.match(notice.message, /background supervisor/);
    assert.match(notice.message, /\/graph run, \/graph cancel and \/graph resume/);
  }
  assert.equal(calls.length, 0);
});

test("run spawns the exact argv with cwd and returns before the child exits", async () => {
  const { graph, calls, statuses, notices, ctx } = setup();
  await graph.handler("run plan.json --run-id run-7", ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, process.execPath);
  assert.deepEqual(calls[0]?.args, [CLI, "run", "--worker", "pi", "--graph", "plan.json", "--run-id", "run-7"]);
  assert.equal(calls[0]?.options.cwd, "/work/repo");
  assert.deepEqual(calls[0]?.options.env, { PATH: "fake" });
  assert.deepEqual(statuses, ["graph: running run-7"]);
  assert.deepEqual(notices, []);
});

test("run without --run-id labels the status with the plan", async () => {
  const { graph, calls, statuses, ctx } = setup();
  await graph.handler("run plan.json", ctx);
  assert.deepEqual(calls[0]?.args, [CLI, "run", "--worker", "pi", "--graph", "plan.json"]);
  assert.deepEqual(statuses, ["graph: running plan.json"]);
});

test("run rejects missing, flag-like and control-character arguments without spawning", async () => {
  const { graph, calls, notices, ctx } = setup();
  await graph.handler("run", ctx);
  await graph.handler("run --graph", ctx);
  await graph.handler("run plan\u0007.json", ctx);
  await graph.handler("run plan.json --run-id", ctx);
  await graph.handler("run plan.json --run-id a\u001bb", ctx);
  await graph.handler("run plan.json --other x", ctx);
  assert.equal(notices.length, 6);
  assert.ok(notices.every((notice) => notice.level === "warning"));
  assert.equal(calls.length, 0);
});

test("stderr progress lines reach the widget, limited to the last eight", async () => {
  const { graph, calls, widgets, ctx } = setup();
  await graph.handler("run plan.json", ctx);
  const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
  calls[0]?.child.stderr.write(`${lines.join("\n")}\npartial`);
  await tick();
  assert.deepEqual(widgets.at(-1), lines.slice(2));
});

test("exit 0 with a JSON report notifies the summary and clears the widget and status", async () => {
  const { graph, calls, notices, widgets, statuses, ctx } = setup();
  await graph.handler("run plan.json", ctx);
  calls[0]?.child.stderr.write("progress\n");
  await tick();
  calls[0]?.child.exit(0, JSON.stringify({ runId: "run-1", finalStatus: "succeeded", sessions: "/s/run-1" }));
  assert.deepEqual(notices, [{ message: "graph run run-1: succeeded (exit 0), sessions: /s/run-1", level: "info" }]);
  assert.equal(widgets.at(-1), undefined);
  assert.equal(statuses.at(-1), undefined);
  // The child is forgotten, so another run may start.
  await graph.handler("run plan.json", ctx);
  assert.equal(calls.length, 2);
});

test("a non-zero exit notifies an error with the JSON report", async () => {
  const { graph, calls, notices, ctx } = setup();
  await graph.handler("run plan.json", ctx);
  calls[0]?.child.exit(1, JSON.stringify({ runId: "run-1", finalStatus: "failed" }));
  assert.deepEqual(notices, [{ message: "graph run run-1: failed (exit 1)", level: "error" }]);
});

test("a non-zero exit without JSON passes the stderr tail in the error", async () => {
  const { graph, calls, notices, ctx } = setup();
  await graph.handler("run plan.json", ctx);
  calls[0]?.child.stderr.write("Plan file not found\n");
  await tick();
  calls[0]?.child.exit(1, "not json");
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.level, "error");
  assert.match(notices[0]?.message ?? "", /exited with code 1:\nPlan file not found/);
});

test("a spawn error notifies and frees the slot", async () => {
  const { graph, calls, notices, widgets, ctx } = setup();
  await graph.handler("run plan.json", ctx);
  calls[0]?.child.emit("error", new Error("spawn ENOENT"));
  assert.deepEqual(notices, [{ message: "graph run plan.json could not run: spawn ENOENT", level: "error" }]);
  assert.equal(widgets.at(-1), undefined);
  await graph.handler("run plan.json", ctx);
  assert.equal(calls.length, 2);
});

test("a second run or resume while one is active is refused", async () => {
  const { graph, calls, notices, ctx } = setup();
  await graph.handler("run plan.json", ctx);
  await graph.handler("run other.json", ctx);
  await graph.handler("resume run-2", ctx);
  assert.equal(calls.length, 1);
  assert.equal(notices.length, 2);
  for (const notice of notices) {
    assert.equal(notice.level, "warning");
    assert.match(notice.message, /already active/);
  }
});

test("resume spawns run --resume", async () => {
  const { graph, calls, statuses, ctx } = setup();
  await graph.handler("resume run-9", ctx);
  assert.deepEqual(calls[0]?.args, [CLI, "run", "--worker", "pi", "--resume", "run-9"]);
  assert.equal(calls[0]?.options.cwd, "/work/repo");
  assert.deepEqual(statuses, ["graph: running run-9"]);
});

test("cancel sends SIGINT to the active child", async () => {
  const { graph, calls, notices, ctx } = setup();
  await graph.handler("run plan.json", ctx);
  await graph.handler("cancel", ctx);
  assert.deepEqual(calls[0]?.child.signals, ["SIGINT"]);
  assert.match(notices[0]?.message ?? "", /Cancelling graph run plan\.json/);
});

test("cancel with no active run notifies and signals nothing", async () => {
  const { graph, calls, notices, ctx } = setup();
  await graph.handler("cancel", ctx);
  assert.deepEqual(notices, [{ message: "No graph run is active in this Pi session.", level: "info" }]);
  assert.equal(calls.length, 0);
});

test("status lists runs and whether this session has one active", async () => {
  const { graph, calls, notices, ctx } = setup();
  const pending = graph.handler("status", ctx);
  await tick();
  assert.deepEqual(calls[0]?.args, [CLI, "status"]);
  assert.equal(calls[0]?.options.cwd, "/work/repo");
  calls[0]?.child.exit(
    0,
    JSON.stringify({
      mode: "status",
      runs: [
        { runId: "run-b", status: "succeeded" },
        { runId: "run-a", status: "running" },
        { runId: "run-x", error: "bad journal" },
      ],
    }),
  );
  await pending;
  assert.deepEqual(notices, [
    {
      message: "run-b: succeeded\nrun-a: running\nrun-x: unreadable (bad journal)\nno run active in this Pi session",
      level: "info",
    },
  ]);
});

test("status reports a CLI failure as an error", async () => {
  const { graph, calls, notices, ctx } = setup();
  const pending = graph.handler("status", ctx);
  await tick();
  calls[0]?.child.stderr.write("boom");
  calls[0]?.child.exit(2);
  await pending;
  assert.equal(notices[0]?.level, "error");
  assert.match(notices[0]?.message ?? "", /graph status failed \(exit 2\): boom/);
});

test("status names the active run", async () => {
  const { graph, calls, notices, ctx } = setup();
  await graph.handler("run plan.json --run-id run-3", ctx);
  const pending = graph.handler("status", ctx);
  await tick();
  calls[1]?.child.exit(0, JSON.stringify({ mode: "status", runs: [] }));
  await pending;
  assert.equal(notices[0]?.message, "no runs found\nrun active in this Pi session: run-3");
});

test("inspect summarises status, node dispositions, sessions and verification", async () => {
  const { graph, calls, notices, ctx } = setup();
  const pending = graph.handler("inspect run-1", ctx);
  await tick();
  assert.deepEqual(calls[0]?.args, [CLI, "inspect", "run-1"]);
  calls[0]?.child.exit(
    0,
    JSON.stringify({
      mode: "inspect",
      runId: "run-1",
      status: "succeeded",
      sessions: "/s/run-1",
      verification: { outcome: "passed" },
      nodes: { impl: { disposition: "accepted" }, review: { disposition: "accepted" } },
    }),
  );
  await pending;
  assert.deepEqual(notices, [
    {
      message: "run run-1: succeeded\n  impl: accepted\n  review: accepted\nsessions: /s/run-1\nverification: passed",
      level: "info",
    },
  ]);
});

test("inspect needs a run ID and reports an unknown run as an error", async () => {
  const { graph, calls, notices, ctx } = setup();
  await graph.handler("inspect", ctx);
  assert.equal(notices[0]?.level, "warning");
  assert.equal(calls.length, 0);
  const pending = graph.handler("inspect nope", ctx);
  await tick();
  calls[0]?.child.stderr.write("No journal found for run nope\n");
  calls[0]?.child.exit(1);
  await pending;
  assert.equal(notices[1]?.level, "error");
  assert.match(notices[1]?.message ?? "", /No journal found for run nope/);
});

test("a missing CLI notifies an error naming the path and AUTO_PI_LOT_CLI and spawns nothing", async () => {
  const { graph, calls, notices, ctx } = setup(() => "/nonexistent/auto-pi-lot/index.js");
  await graph.handler("run plan.json", ctx);
  await graph.handler("status", ctx);
  await graph.handler("inspect run-1", ctx);
  assert.equal(notices.length, 3);
  for (const notice of notices) {
    assert.equal(notice.level, "error");
    assert.match(notice.message, /\/nonexistent\/auto-pi-lot\/index\.js/);
    assert.match(notice.message, /AUTO_PI_LOT_CLI/);
  }
  assert.equal(calls.length, 0);
});

test("session shutdown sends SIGINT to the active child and is harmless without one", async () => {
  const { graph, calls, ctx } = setup();
  graph.shutdown();
  await graph.handler("run plan.json", ctx);
  graph.shutdown();
  assert.deepEqual(calls[0]?.child.signals, ["SIGINT"]);
});

test("the registered session_shutdown listener is harmless when no run is active", () => {
  const { api, listeners } = createFakeApi();
  autoPiLot(api);
  assert.doesNotThrow(() => listeners.get("session_shutdown")?.());
});

test("a run outlives a stale Pi context: progress and the final notice never throw from the child's events", async () => {
  const { graph, calls, notices, ctx } = setup();
  let stale = false;
  const ui = ctx.ui;
  // Pi's command context checks liveness on every `ui` access and throws once the session is replaced.
  const liveCtx = {
    cwd: ctx.cwd,
    get ui() {
      if (stale) throw new Error("This extension ctx is stale after session replacement");
      return ui;
    },
  } as unknown as ExtensionCommandContext;
  await graph.handler("run plan.json", liveCtx);
  stale = true;
  const child = calls[0]?.child as FakeChild;
  assert.doesNotThrow(() => child.stderr.write("12:00:00 attempt_dispatched node=a\n"));
  await tick();
  assert.doesNotThrow(() => child.exit(1, JSON.stringify({ runId: "r", finalStatus: "cancelled" })));
  await tick();
  assert.deepEqual(notices.at(-1), { message: "graph run r: cancelled (exit 1)", level: "error" });

  const throwing = setup();
  const brokenCtx = {
    cwd: "/work/repo",
    ui: {
      notify: () => {
        throw new Error("ui gone");
      },
      setWidget: () => {
        throw new Error("ui gone");
      },
      setStatus: () => undefined,
    },
  } as unknown as ExtensionCommandContext;
  await throwing.graph.handler("run plan.json", brokenCtx);
  const second = throwing.calls[0]?.child as FakeChild;
  second.stderr.write("line\n");
  await tick();
  assert.doesNotThrow(() => second.exit(0, "{}"));
});

test("cancel and shutdown send SIGINT once per run, because a second SIGINT forces the CLI to exit", async () => {
  const { graph, calls, notices, ctx } = setup();
  await graph.handler("run plan.json", ctx);
  await graph.handler("cancel", ctx);
  await graph.handler("cancel", ctx);
  graph.shutdown();
  assert.deepEqual(calls[0]?.child.signals, ["SIGINT"]);
  assert.match(notices.at(-1)?.message ?? "", /already cancelling/i);
});

test("an error event after the child started does not free the slot while it still runs", async () => {
  const { graph, calls, notices, ctx } = setup();
  await graph.handler("run plan.json", ctx);
  const child = calls[0]?.child as FakeChild;
  Object.assign(child, { pid: 4242 });
  child.emit("error", new Error("kill EPERM"));
  await graph.handler("run plan.json", ctx);
  assert.equal(calls.length, 1, "the first run is still active");
  child.exit(0, JSON.stringify({ runId: "r", finalStatus: "succeeded" }));
  await tick();
  assert.deepEqual(notices.at(-1), { message: "graph run r: succeeded (exit 0)", level: "info" });
});
