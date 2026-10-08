import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  type ArtifactStore,
  type CheckProfile,
  type CheckReceipt,
  CheckReceiptSchema,
  digest,
  identifyEvidence,
} from "@auto-pi-lot/core";

import {
  buildCheckEnv,
  CHECK_ENV_ALLOWLIST,
  type ChildLike,
  parseTestCount,
  type RunCheckInput,
  runCheck,
  type SpawnLike,
  type SpawnOptionsLike,
} from "../src/index.js";

class MemoryArtifacts implements ArtifactStore {
  readonly blobs = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array): Promise<string> {
    const id = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    this.blobs.set(id, bytes);
    return id;
  }
  async get(id: string): Promise<Uint8Array | null> {
    return this.blobs.get(id) ?? null;
  }
  text(id: string | undefined): string {
    return Buffer.from((id === undefined ? undefined : this.blobs.get(id)) ?? "").toString("utf8");
  }
}

class FakeChild extends EventEmitter {
  pid: number | undefined = 4242;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly killed: (NodeJS.Signals | undefined)[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal);
    return true;
  }
}

interface Spawned {
  command: string;
  args: readonly string[];
  options: SpawnOptionsLike;
}

function fakeSpawn(script: (child: FakeChild) => void): { spawn: SpawnLike; calls: Spawned[]; child: FakeChild } {
  const child = new FakeChild();
  const calls: Spawned[] = [];
  const spawn: SpawnLike = (command, args, options) => {
    calls.push({ command, args, options });
    queueMicrotask(() => script(child));
    return child as unknown as ChildLike;
  };
  return { spawn, calls, child };
}

const profile: CheckProfile = { id: "unit", command: "npm", args: ["test"] };
const fixedClock = (): (() => Date) => {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 9, 8, 12, 0, tick++));
};

function inputFor(artifacts: MemoryArtifacts, extra: Partial<RunCheckInput> = {}): RunCheckInput {
  return {
    workspace: path.resolve("/virtual/workspace"),
    runId: "run-1",
    attemptId: "attempt-1",
    sourceDigest: "sha256:source",
    artifacts,
    clock: fixedClock(),
    env: {},
    kill: () => undefined,
    ...extra,
  };
}

test("exit 0 is a pass and the receipt is valid and content addressed", async () => {
  const artifacts = new MemoryArtifacts();
  const { spawn, calls } = fakeSpawn((child) => {
    child.stdout.emit("data", Buffer.from("hello\n"));
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  const receipt = await runCheck(profile, inputFor(artifacts, { spawn }));
  assert.equal(receipt.outcome, "pass");
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.kind, "check");
  assert.equal(receipt.profileId, "unit");
  assert.equal(receipt.profileVersion, digest(profile));
  assert.equal(receipt.executable, "npm");
  assert.deepEqual(receipt.args, ["test"]);
  assert.equal(receipt.sourceDigest, "sha256:source");
  assert.equal(receipt.inputDigest, digest({ profileId: "unit", sourceDigest: "sha256:source" }));
  assert.equal(receipt.startedAt, "2026-10-08T12:00:00.000Z");
  assert.equal(receipt.finishedAt, "2026-10-08T12:00:01.000Z");
  assert.equal(artifacts.text(receipt.logArtifactIds[0]), "hello\n");
  assert.equal(CheckReceiptSchema.safeParse(receipt).success, true);
  const { id: _id, ...content } = receipt;
  assert.equal(identifyEvidence<CheckReceipt>(content).id, receipt.id);
  assert.equal(calls[0]?.options.shell, false);
  assert.equal(calls[0]?.options.cwd, path.resolve("/virtual/workspace"));
});

test("normal exit also terminates background descendants", { skip: process.platform === "win32" }, async () => {
  const artifacts = new MemoryArtifacts();
  const { spawn } = fakeSpawn((child) => {
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  const killed: number[] = [];
  const receipt = await runCheck(
    profile,
    inputFor(artifacts, {
      spawn,
      kill: (pid) => {
        killed.push(pid);
      },
    }),
  );
  assert.equal(receipt.outcome, "pass");
  assert.deepEqual(killed, [-4242]);
});

test("a real successful check cannot leave a background writer running", {
  skip: process.platform === "win32",
  timeout: 5000,
}, async (t) => {
  const workspace = await mkdtemp(path.join(tmpdir(), "apl-background-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const artifacts = new MemoryArtifacts();
  const script = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', "setTimeout(() => require('node:fs').writeFileSync('late.txt', 'unexpected'), 500)"], { stdio: 'ignore' });
    child.unref();
    process.exit(0);
  `;
  const receipt = await runCheck(
    { id: "background", command: process.execPath, args: ["-e", script] },
    {
      workspace,
      runId: "run",
      attemptId: "attempt",
      sourceDigest: "sha256:source",
      artifacts,
    },
  );
  assert.equal(receipt.outcome, "pass");
  await new Promise((resolve) => setTimeout(resolve, 700));
  await assert.rejects(readFile(path.join(workspace, "late.txt")), { code: "ENOENT" });
});

test("a non-zero exit or a signal is a fail", async () => {
  const artifacts = new MemoryArtifacts();
  const exits = fakeSpawn((child) => {
    child.emit("exit", 2, null);
    child.emit("close", 2, null);
  });
  const failed = await runCheck(profile, inputFor(artifacts, { spawn: exits.spawn }));
  assert.equal(failed.outcome, "fail");
  assert.equal(failed.exitCode, 2);

  const signalled = fakeSpawn((child) => {
    child.emit("exit", null, "SIGSEGV");
    child.emit("close", null, "SIGSEGV");
  });
  const crashed = await runCheck(profile, inputFor(artifacts, { spawn: signalled.spawn }));
  assert.equal(crashed.outcome, "fail");
  assert.equal(crashed.exitCode, null);
});

test("a timeout kills the process group and reports timeout", async () => {
  const artifacts = new MemoryArtifacts();
  const { spawn, child } = fakeSpawn(() => undefined);
  const killed: [number, NodeJS.Signals][] = [];
  const kill = (pid: number, signal: NodeJS.Signals): void => {
    killed.push([pid, signal]);
    queueMicrotask(() => child.emit("close", null, signal));
  };
  const receipt = await runCheck({ ...profile, timeoutMs: 20 }, inputFor(artifacts, { spawn, kill }));
  assert.equal(receipt.outcome, "timeout");
  if (process.platform === "win32") {
    assert.deepEqual(child.killed, ["SIGKILL"]);
  } else {
    assert.deepEqual(killed, [[-4242, "SIGKILL"]]);
  }
  assert.match(artifacts.text(receipt.logArtifactIds[0]), /timed out/);
});

test("a spawn error is an error outcome without an exit code", async () => {
  const artifacts = new MemoryArtifacts();
  const { spawn } = fakeSpawn((child) => {
    child.pid = undefined;
    child.emit("error", new Error("spawn npm ENOENT"));
  });
  const receipt = await runCheck(profile, inputFor(artifacts, { spawn }));
  assert.equal(receipt.outcome, "error");
  assert.equal(receipt.exitCode, null);
  assert.match(artifacts.text(receipt.logArtifactIds[0]), /ENOENT/);

  const throwing: SpawnLike = () => {
    throw new Error("boom");
  };
  const thrown = await runCheck(profile, inputFor(artifacts, { spawn: throwing }));
  assert.equal(thrown.outcome, "error");
});

test("the child gets only allowlisted environment variables", async () => {
  const artifacts = new MemoryArtifacts();
  const { spawn, calls } = fakeSpawn((child) => {
    child.emit("close", 0, null);
  });
  await runCheck(
    profile,
    inputFor(artifacts, {
      spawn,
      env: {
        PATH: "/bin",
        HOME: "/home/x",
        ANTHROPIC_API_KEY: "secret",
        OPENAI_API_KEY: "secret",
        NODE_OPTIONS: "--x",
      },
    }),
  );
  const env = calls[0]?.options.env ?? {};
  assert.deepEqual(env, { PATH: "/bin", HOME: "/home/x", CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" });
  assert.equal("ANTHROPIC_API_KEY" in env, false);
  const allowed = new Set([...CHECK_ENV_ALLOWLIST, "CI", "NO_COLOR", "FORCE_COLOR"]);
  for (const key of Object.keys(buildCheckEnv(Object.fromEntries(CHECK_ENV_ALLOWLIST.map((key) => [key, "v"]))))) {
    assert.ok(allowed.has(key));
  }
});

test("the log keeps the last bytes with a truncation marker", async () => {
  const artifacts = new MemoryArtifacts();
  const { spawn } = fakeSpawn((child) => {
    child.stdout.emit("data", Buffer.from("AAAAAAAAAA"));
    child.stderr.emit("data", Buffer.from("BBBBBBBBBB"));
    child.stdout.emit("data", "CCCCC");
    child.emit("close", 1, null);
  });
  const receipt = await runCheck(profile, inputFor(artifacts, { spawn, maxLogBytes: 12 }));
  const text = artifacts.text(receipt.logArtifactIds[0]);
  assert.equal(text, "[auto-pi-lot: log truncated, first 13 bytes dropped]\nBBBBBBBCCCCC");
});

test("a node:test summary becomes testCount", async () => {
  const artifacts = new MemoryArtifacts();
  const { spawn } = fakeSpawn((child) => {
    child.stdout.emit("data", "ℹ tests 9\nℹ pass 7\nℹ fail 1\nℹ skipped 1\n");
    child.emit("close", 1, null);
  });
  const receipt = await runCheck(profile, inputFor(artifacts, { spawn }));
  assert.deepEqual(receipt.testCount, { passed: 7, failed: 1, skipped: 1 });
  assert.deepEqual(parseTestCount("# pass 3\n# fail 0\n# skip 2\n"), { passed: 3, failed: 0, skipped: 2 });
  assert.equal(parseTestCount("nothing here"), null);

  const quiet = fakeSpawn((child) => child.emit("close", 0, null));
  const without = await runCheck(profile, inputFor(artifacts, { spawn: quiet.spawn }));
  assert.equal("testCount" in without, false);
});

test("a cwd outside the workspace is an error and nothing is spawned", async () => {
  const artifacts = new MemoryArtifacts();
  const { spawn, calls } = fakeSpawn(() => undefined);
  for (const cwd of ["../elsewhere", "/etc"]) {
    const receipt = await runCheck({ ...profile, cwd }, inputFor(artifacts, { spawn }));
    assert.equal(receipt.outcome, "error");
    assert.equal(receipt.exitCode, null);
    assert.match(artifacts.text(receipt.logArtifactIds[0]), /outside the workspace/);
  }
  assert.equal(calls.length, 0);
  const inside = fakeSpawn((child) => child.emit("close", 0, null));
  await runCheck({ ...profile, cwd: "packages/x" }, inputFor(artifacts, { spawn: inside.spawn }));
  assert.equal(inside.calls[0]?.options.cwd, path.resolve("/virtual/workspace", "packages/x"));
});

test("a symlinked directory that leads outside the workspace is refused", async () => {
  const artifacts = new MemoryArtifacts();
  const workspace = await mkdtemp(path.join(tmpdir(), "apl-check-ws-"));
  const outside = await mkdtemp(path.join(tmpdir(), "apl-check-out-"));
  await mkdir(path.join(workspace, "real"));
  await symlink(outside, path.join(workspace, "link"));
  const { spawn, calls } = fakeSpawn(() => undefined);
  const refused = await runCheck({ ...profile, cwd: "link" }, inputFor(artifacts, { spawn, workspace }));
  assert.equal(refused.outcome, "error");
  assert.equal(refused.exitCode, null);
  assert.match(artifacts.text(refused.logArtifactIds[0]), /outside the workspace/);
  assert.equal(calls.length, 0);

  const inside = fakeSpawn((child) => child.emit("close", 0, null));
  const accepted = await runCheck({ ...profile, cwd: "real" }, inputFor(artifacts, { spawn: inside.spawn, workspace }));
  assert.equal(accepted.outcome, "pass");
  assert.equal(inside.calls.length, 1);
});

test("aborting the signal kills the process group and reports error with a cancelled note", async () => {
  const artifacts = new MemoryArtifacts();
  const controller = new AbortController();
  const { spawn, child, calls } = fakeSpawn(() => controller.abort());
  const killed: [number, NodeJS.Signals][] = [];
  const kill = (pid: number, name: NodeJS.Signals): void => {
    killed.push([pid, name]);
    queueMicrotask(() => child.emit("close", null, name));
  };
  const receipt = await runCheck(profile, inputFor(artifacts, { spawn, kill, signal: controller.signal }));
  assert.equal(calls.length, 1);
  assert.equal(receipt.outcome, "error");
  if (process.platform === "win32") {
    assert.deepEqual(child.killed, ["SIGKILL"]);
  } else {
    assert.deepEqual(killed, [[-4242, "SIGKILL"]]);
  }
  assert.match(artifacts.text(receipt.logArtifactIds[0]), /\[auto-pi-lot: check cancelled\]/);
  assert.equal(CheckReceiptSchema.safeParse(receipt).success, true);
});

test("an already aborted signal spawns nothing", async () => {
  const artifacts = new MemoryArtifacts();
  const { spawn, calls } = fakeSpawn(() => undefined);
  const receipt = await runCheck(profile, inputFor(artifacts, { spawn, signal: AbortSignal.abort() }));
  assert.equal(calls.length, 0);
  assert.equal(receipt.outcome, "error");
  assert.equal(receipt.exitCode, null);
  assert.match(artifacts.text(receipt.logArtifactIds[0]), /check cancelled/);
});

test("the default spawn runs a real process and reports its exit status", async () => {
  const artifacts = new MemoryArtifacts();
  const workspace = process.cwd();
  const failing = await runCheck(
    { id: "real-fail", command: process.execPath, args: ["-e", "console.log('out'); process.exit(3)"] },
    { ...inputFor(artifacts), workspace, env: process.env },
  );
  assert.equal(failing.outcome, "fail");
  assert.equal(failing.exitCode, 3);
  assert.match(artifacts.text(failing.logArtifactIds[0]), /out/);

  const passing = await runCheck(
    { id: "real-pass", command: process.execPath, args: ["-e", "process.exit(0)"] },
    { ...inputFor(artifacts), workspace, env: process.env },
  );
  assert.equal(passing.outcome, "pass");
});
