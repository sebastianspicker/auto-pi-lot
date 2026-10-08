import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { lintGraph, ProjectConfigSchema, parseDto, validateGraph, validateGraphChecks } from "@auto-pi-lot/core";

import { encodeRunId } from "@auto-pi-lot/host";

import { demoGraphInput } from "../src/demo.js";
import { checkWorkspace, sanitizeLine } from "../src/run.js";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

function run(...args: string[]) {
  return spawnSync(process.execPath, [entry, ...args], { encoding: "utf8" });
}

test("an unknown command exits 1 and prints the usage line", () => {
  const result = run("bogus");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Usage: /);
});

test("demo exits 0 and prints parseable JSON", () => {
  const result = run("demo");
  assert.equal(result.status, 0);
  assert.equal(typeof JSON.parse(result.stdout), "object");
});

test("run journals the example graph to a file, retries the scripted crash and succeeds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "auto-pi-lot-run-"));
  const result = run("run", "--journal", dir);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, "run");
  assert.equal(output.worker, "fake");
  assert.equal(output.finalStatus, "succeeded");
  assert.equal(output.resumed, false);
  assert.deepEqual(output.evidence, { implement: [], verify: [], review: [] });
  assert.equal(output.replayMatches, true);
  assert.ok(output.journal.startsWith(dir));
  const types = output.events.map((event: { type: string }) => event.type);
  assert.equal(types[0], "run_started");
  assert.ok(types.includes("attempt_failed"));
  assert.equal(output.nodes.implement.attemptCount, 2);
  assert.equal(output.nodes.review.disposition, "accepted");
  assert.ok((await readFile(output.journal, "utf8")).split("\n").filter(Boolean).length === output.events.length);

  const resumed = run("run", "--journal", dir, "--worker", "fake", "--resume", output.runId);
  assert.equal(resumed.status, 0, resumed.stderr);
  const again = JSON.parse(resumed.stdout);
  assert.equal(again.resumed, true);
  assert.equal(again.finalStatus, "succeeded");
  assert.equal(again.events.length, output.events.length);
});

test("run rejects an unknown option with the run usage line", () => {
  const result = run("run", "--bogus");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: auto-pi-lot run/);
});

test("run with a missing option value exits 1 with the run usage line", () => {
  const result = run("run", "--journal");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: auto-pi-lot run/);
});

const node = (id: string, role: string) => ({
  id,
  role,
  objective: `Do ${id}`,
  acceptanceCriteria: ["Done"],
  limits: { maxTokens: 1000, maxToolCalls: 10 },
});

async function writeGraph(graph: unknown, name = "graph.json"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "auto-pi-lot-graph-"));
  const file = join(dir, name);
  await writeFile(file, typeof graph === "string" ? graph : JSON.stringify(graph), "utf8");
  return file;
}

const graphOf = (runId: string, nodes: unknown[], edges: unknown[]) => ({
  schemaVersion: 1,
  id: "graph-1",
  runId,
  depth: 0,
  revision: 1,
  nodes,
  edges,
});

test("validate accepts the demo graph without warnings", async () => {
  const file = await writeGraph(demoGraphInput);
  const result = run("validate", file);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.deepEqual(output.topologicalOrder, ["implement", "verify", "review"]);
  assert.deepEqual(output.readyNodeIds, ["implement"]);
  assert.deepEqual(output.warnings, []);
});

test("validate reports a cycle as an issue and exits 1", async () => {
  const file = await writeGraph(
    graphOf(
      "run-cycle",
      [node("a", "planner"), node("b", "planner")],
      [
        { from: "a", to: "b", condition: "accepted" },
        { from: "b", to: "a", condition: "accepted" },
      ],
    ),
  );
  const result = run("validate", file);
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.ok(output.issues.some((issue: { code: string }) => issue.code === "cycle"));
});

test("validate --strict turns warnings into exit 1", async () => {
  const file = await writeGraph(graphOf("run-strict", [node("only", "implementer")], []));
  const strict = run("validate", file, "--strict");
  assert.equal(strict.status, 1);
  const output = JSON.parse(strict.stdout);
  assert.equal(output.ok, true);
  assert.deepEqual(
    output.warnings.map((warning: { code: string }) => warning.code),
    ["unverified_producer"],
  );
  assert.equal(run("validate", file).status, 0);
});

test("validate on a missing file exits 2 with the validate usage line", () => {
  const result = run("validate", join(tmpdir(), "auto-pi-lot-does-not-exist.json"));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: auto-pi-lot validate/);
});

test("validate on a file that is not JSON exits 2", async () => {
  const result = run("validate", await writeGraph("not json {"));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not valid JSON/);
});

test("run --graph executes a graph file under the given policy and refuses to start it twice", async () => {
  const file = await writeGraph(
    graphOf(
      `file-${process.pid}-${Date.now()}`,
      [node("a", "implementer"), node("b", "reviewer")],
      [{ from: "a", to: "b", condition: "accepted" }],
    ),
  );
  const dir = await mkdtemp(join(tmpdir(), "auto-pi-lot-run-"));
  const args = ["run", "--graph", file, "--journal", dir, "--max-concurrent", "1", "--max-attempts", "1"];
  const result = run(...args);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.finalStatus, "succeeded");
  assert.equal(output.graphFile, file);
  assert.equal(output.nodes.a.disposition, "accepted");
  assert.equal(output.nodes.b.disposition, "accepted");
  assert.equal(output.replayMatches, true);

  const again = run(...args);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /resume/);
});

test("run --graph cannot be combined with --resume", () => {
  const result = run("run", "--graph", "x", "--resume", "y");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: auto-pi-lot run/);
});

const SECOND_PROFILE = { id: "unit", command: "npm", args: ["run", "test"] };

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "auto-pi-lot-ws-"));
}

test("run --worker pi without a graph or run id exits 1 with the run usage line", () => {
  const result = run("run", "--worker", "pi");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--worker pi requires/);
  assert.match(result.stderr, /Usage: auto-pi-lot run/);
});

test("run with an unknown worker exits 1", () => {
  const result = run("run", "--worker", "bogus");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown worker: bogus/);
});

test("run --model without a slash exits 1", () => {
  const result = run("run", "--worker", "pi", "--graph", "x", "--model", "gpt");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--model must be <provider>\/<id>/);
});

test("run --worker pi refuses a plan naming an unknown check profile before opening a session", async () => {
  const workspace = await tempDir();
  const file = await writeGraph(
    graphOf(
      "run-unknown-check",
      [{ ...node("a", "implementer"), checks: ["missing"] }, node("b", "reviewer")],
      [{ from: "a", to: "b", condition: "result_ready" }],
    ),
  );
  const result = run("run", "--worker", "pi", "--graph", file, "--workspace", workspace, "--quiet");
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).issues[0].code, "unknown_check_profile");
});

test("run --worker pi refuses lint warnings before opening a session", async () => {
  const workspace = await tempDir();
  await writeFile(join(workspace, "auto-pi-lot.json"), JSON.stringify({ schemaVersion: 1, checks: [SECOND_PROFILE] }));
  const file = await writeGraph(graphOf("run-warn", [node("only", "implementer")], []));
  const result = run("run", "--worker", "pi", "--graph", file, "--workspace", workspace);
  assert.equal(result.status, 1);
  assert.deepEqual(
    JSON.parse(result.stdout).warnings.map((warning: { code: string }) => warning.code),
    ["unverified_producer"],
  );
  assert.match(result.stderr, /--allow-warnings/);
});

test("run with an invalid configuration exits 2 and names the problem", async () => {
  const workspace = await tempDir();
  await writeFile(join(workspace, "auto-pi-lot.json"), JSON.stringify({ schemaVersion: 1, checks: [], bogus: 1 }));
  const result = run("run", "--workspace", workspace);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not a valid configuration/);
});

test("run in a workspace journals under .auto-pi-lot and prints progress lines, which --quiet drops", async () => {
  const workspace = await tempDir();
  const result = run("run", "--workspace", workspace);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.ok(output.journal.startsWith(join(await realpath(workspace), ".auto-pi-lot", "journal")));
  assert.match(result.stderr, /^\d\d:\d\d:\d\d run_started/m);
  assert.match(result.stderr, /attempt_dispatched node=implement attempt=/);
  assert.equal(run("run", "--workspace", workspace, "--quiet").stderr, "");
});

test("init writes a config and a plan that pass the validators, and refuses to overwrite them", async () => {
  const workspace = await tempDir();
  await writeFile(
    join(workspace, "package.json"),
    JSON.stringify({ scripts: { build: "tsc", test: "node --test", start: "node ." } }),
  );
  const result = run("init", "--workspace", workspace);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /auto-pi-lot run --worker pi --graph auto-pi-lot\.plan\.json/);
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, "init");
  assert.deepEqual(output.checks, ["test", "build"]);

  const config = parseDto(ProjectConfigSchema, JSON.parse(await readFile(join(workspace, "auto-pi-lot.json"), "utf8")));
  assert.ok(config.ok);
  assert.deepEqual(config.value.policy, { maxConcurrent: 1, maxAttemptsPerNode: 2, maxConcurrentWriters: 1 });
  const validated = validateGraph(JSON.parse(await readFile(join(workspace, "auto-pi-lot.plan.json"), "utf8")));
  assert.ok(validated.ok);
  assert.deepEqual(validateGraphChecks(validated.graph, config.value.checks), []);
  assert.deepEqual(lintGraph(validated.graph), []);

  const again = run("init", "--workspace", workspace);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /auto-pi-lot\.json already exists/);
  assert.equal(run("init", "--workspace", workspace, "--force").status, 0);
});

test("init without a package.json writes no checks and still validates", async () => {
  const workspace = await tempDir();
  const result = run("init", "--workspace", workspace);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).checks, []);
  const validated = validateGraph(JSON.parse(await readFile(join(workspace, "auto-pi-lot.plan.json"), "utf8")));
  assert.ok(validated.ok);
});

test("status and inspect read the journal of a finished run; artifact reports unknown ids", async () => {
  const workspace = await tempDir();
  const ran = JSON.parse(run("run", "--workspace", workspace, "--quiet").stdout);

  const status = run("status", "--workspace", workspace);
  assert.equal(status.status, 0, status.stderr);
  const listing = JSON.parse(status.stdout);
  assert.equal(listing.runs.length, 1);
  assert.equal(listing.runs[0].runId, ran.runId);
  assert.equal(listing.runs[0].status, "succeeded");
  assert.equal(listing.runs[0].nodeCount, 3);
  assert.equal(listing.runs[0].eventCount, ran.events.length);

  const inspected = run("inspect", ran.runId, "--workspace", workspace);
  assert.equal(inspected.status, 0, inspected.stderr);
  const report = JSON.parse(inspected.stdout);
  assert.equal(report.mode, "inspect");
  assert.equal(report.status, "succeeded");
  assert.equal(report.events.length, ran.events.length);
  assert.equal(report.nodes.implement.attemptCount, 2);
  assert.equal(Object.keys(report.attempts).length, 4);
  assert.deepEqual(report.evidence, { implement: [], verify: [], review: [] });

  assert.equal(run("inspect", "no-such-run", "--workspace", workspace).status, 1);
  assert.equal(run("inspect", "--workspace", workspace).status, 1);
  assert.equal(run("artifact", `sha256:${"0".repeat(64)}`, "--workspace", workspace).status, 1);
});

test("status on a missing journal directory lists no runs, and reports a corrupt journal in its entry", async () => {
  const workspace = await tempDir();
  const empty = run("status", "--workspace", workspace);
  assert.equal(empty.status, 0);
  assert.deepEqual(JSON.parse(empty.stdout).runs, []);

  const journal = join(workspace, "journals");
  await mkdir(journal);
  await writeFile(join(journal, "run-broken.jsonl"), "not json\nstill not json\n");
  const broken = run("status", "--journal", journal);
  assert.equal(broken.status, 0, broken.stderr);
  const [entry] = JSON.parse(broken.stdout).runs;
  assert.equal(entry.runId, "run-broken.jsonl");
  assert.equal(typeof entry.error, "string");
});

test("run --resume without --worker exits 1 and names the missing option", () => {
  const result = run("run", "--resume", "some-run");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--resume requires --worker/);
  assert.match(result.stderr, /Usage: auto-pi-lot run/);
});

test("a fake resume of a run with an evidence directory is refused", async () => {
  const workspace = await tempDir();
  const ran = JSON.parse(run("run", "--workspace", workspace, "--quiet").stdout);
  const resumed = run("run", "--workspace", workspace, "--worker", "fake", "--resume", ran.runId, "--quiet");
  assert.equal(resumed.status, 0, resumed.stderr);

  await mkdir(join(workspace, ".auto-pi-lot", "evidence", `run-${encodeRunId(ran.runId)}`), { recursive: true });
  const refused = run("run", "--workspace", workspace, "--worker", "fake", "--resume", ran.runId, "--quiet");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /has recorded evidence; resume it with --worker pi/);
});

test("init adds the runtime directory to .gitignore once and reports it", async () => {
  const workspace = await tempDir();
  await writeFile(join(workspace, ".gitignore"), "node_modules");
  const first = run("init", "--workspace", workspace);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).gitignored, true);
  const ignored = await readFile(join(workspace, ".gitignore"), "utf8");
  assert.equal(ignored.split("\n").filter((line) => line === ".auto-pi-lot/").length, 1);
  assert.ok(ignored.startsWith("node_modules\n"));

  const second = run("init", "--workspace", workspace, "--force");
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).gitignored, false);
  assert.equal(await readFile(join(workspace, ".gitignore"), "utf8"), ignored);
});

test("init --force refuses to overwrite a file that is not a regular file", async () => {
  const workspace = await tempDir();
  await mkdir(join(workspace, "auto-pi-lot.json"));
  const result = run("init", "--workspace", workspace, "--force");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not a regular file; refusing to overwrite it/);
});

test("sanitizeLine escapes control characters and keeps newlines and tabs", () => {
  assert.equal(sanitizeLine("a\u001b[31mb\nc\td\u0007"), "a\\x1b[31mb\nc\td\\x07");
  assert.equal(sanitizeLine("plain text"), "plain text");
});

test("checkWorkspace refuses the file system root and the home directory", async () => {
  assert.match((await checkWorkspace("/")) ?? "", /Refusing to use/);
  assert.match((await checkWorkspace(homedir())) ?? "", /Refusing to use/);
  assert.equal(await checkWorkspace(await tempDir()), null);
});
