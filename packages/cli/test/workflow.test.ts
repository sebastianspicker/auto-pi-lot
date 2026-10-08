import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", timeout: 15_000 });

test("command help succeeds without starting work", () => {
  for (const command of ["run", "check", "init", "inspect", "artifact", "status", "validate"]) {
    const result = run(command, "--help");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Usage: auto-pi-lot ${command}`));
  }
});

test("init → dry-run previews a real plan without model configuration or filesystem changes", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "apl-preview-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  assert.equal(run("init", "--workspace", workspace).status, 0);
  const before = await readdir(workspace);
  const args = [
    "run",
    "--worker",
    "pi",
    "--graph",
    join(workspace, "auto-pi-lot.plan.json"),
    "--workspace",
    workspace,
    "--dry-run",
  ];
  const result = run(...args);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, "preflight");
  assert.equal(report.modelReadiness, "not_checked");
  assert.equal(report.policy.maxConcurrent, 1);
  assert.equal(report.nodes[0].limits.timeoutMs, 1_800_000);
  assert.deepEqual(await readdir(workspace), before);
  await writeFile(
    join(workspace, "auto-pi-lot.json"),
    JSON.stringify({
      schemaVersion: 1,
      checks: [
        { id: "integration", command: process.execPath, args: ["-e", "throw new Error('preview must not execute')"] },
      ],
      finalChecks: ["integration"],
    }),
  );
  const finalPreview = run(...args);
  assert.equal(finalPreview.status, 0, finalPreview.stderr);
  const finalReport = JSON.parse(finalPreview.stdout);
  assert.deepEqual(finalReport.finalCheckIds, ["integration"]);
  assert.equal(finalReport.checks[0].id, "integration");
  assert.ok(finalReport.nodes.every((node: { checks?: string[] }) => !node.checks?.includes("integration")));
  await writeFile(
    join(workspace, "auto-pi-lot.json"),
    JSON.stringify({ schemaVersion: 1, checks: [], finalChecks: ["missing"] }),
  );
  const badFinal = run(...args);
  assert.equal(badFinal.status, 2);
  assert.match(badFinal.stderr, /Unknown final check profile/);
  await writeFile(join(workspace, "auto-pi-lot.json"), JSON.stringify({ schemaVersion: 1, checks: [] }));
  const unsafe = run(...args, "--max-concurrent", "2");
  assert.equal(unsafe.status, 1);
  assert.match(unsafe.stderr, /require --max-concurrent 1/);
  assert.deepEqual(await readdir(workspace), before);
  await writeFile(
    join(workspace, "auto-pi-lot.json"),
    JSON.stringify({ schemaVersion: 1, checks: [], policy: { maxConcurrent: 2, maxAttemptsPerNode: 2 } }),
  );
  const legacy = run(...args);
  assert.equal(legacy.status, 1);
  assert.match(legacy.stderr, /require --max-concurrent 1/);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`${signal} cancels a CLI run and releases journal ownership`, { timeout: 30_000 }, async (t) => {
    const workspace = await mkdtemp(join(tmpdir(), "apl-interrupt-"));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const graph = join(workspace, "plan.json");
    await writeFile(
      graph,
      JSON.stringify({
        schemaVersion: 1,
        id: "interrupt",
        runId: "interrupt-run",
        revision: 1,
        depth: 0,
        nodes: Array.from({ length: 100 }, (_, i) => ({
          id: `task-${i}`,
          role: "implementer",
          objective: "Do work",
          acceptanceCriteria: ["Done"],
          limits: { maxTokens: 1000, maxToolCalls: 10 },
        })),
        edges: [],
      }),
    );
    const child = spawn(
      process.execPath,
      [entry, "run", "--worker", "fake", "--graph", graph, "--workspace", workspace],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    t.after(() => {
      child.kill("SIGKILL");
    });
    let stdout = "";
    let stderr = "";
    let sent = false;
    child.stdout.on("data", (bytes) => {
      stdout += String(bytes);
    });
    child.stderr.on("data", (bytes) => {
      stderr += String(bytes);
      if (!sent && stderr.includes("attempt_dispatched")) {
        sent = true;
        child.kill(signal);
      }
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(sent, true, stderr);
    assert.equal(code, 1, stderr);
    assert.equal(JSON.parse(stdout).finalStatus, "cancelled");
    await assert.rejects(readFile(join(workspace, ".auto-pi-lot", "journal", ".writer.lock")), { code: "ENOENT" });
  });
}

test("check runs configured profiles without a model, returns failures and exposes log artifacts", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "apl-baseline-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(
    join(workspace, "auto-pi-lot.json"),
    JSON.stringify({
      schemaVersion: 1,
      checks: [
        { id: "passing", command: process.execPath, args: ["-e", "console.log('baseline passed')"] },
        { id: "failing", command: process.execPath, args: ["-e", "console.error('baseline failed'); process.exit(3)"] },
      ],
    }),
  );
  const failed = run("check", "--workspace", workspace);
  assert.equal(failed.status, 1, failed.stderr);
  const report = JSON.parse(failed.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.sourceChanged, false);
  assert.deepEqual(
    report.receipts.map((receipt: { outcome: string }) => receipt.outcome),
    ["pass", "fail"],
  );
  const log = run("artifact", report.receipts[1].logArtifactIds[0], "--workspace", workspace);
  assert.equal(log.status, 0, log.stderr);
  assert.match(log.stdout, /baseline failed/);
  const passed = run("check", "--workspace", workspace, "--profile", "passing");
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(JSON.parse(passed.stdout).receipts.length, 1);
  await assert.rejects(readFile(join(workspace, ".auto-pi-lot", "run.lock")), { code: "ENOENT" });
  assert.equal(run("check", "--workspace", workspace, "--profile", "missing").status, 1);
});

test("a check that edits source is not a passing baseline", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "apl-mutating-check-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(
    join(workspace, "auto-pi-lot.json"),
    JSON.stringify({
      schemaVersion: 1,
      checks: [
        {
          id: "mutates",
          command: process.execPath,
          args: ["-e", "require('node:fs').writeFileSync('changed.txt', 'changed')"],
        },
      ],
    }),
  );
  const result = run("check", "--workspace", workspace);
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.sourceChanged, true);
  assert.equal(output.ok, false);
});
