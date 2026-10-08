import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { canonicalJson, digest, type GraphSpec, type JournalEvent, type RunPolicy, replay } from "@auto-pi-lot/core";

import {
  FileJournalStore,
  type HostPorts,
  JournalCorruptError,
  MAX_RECORD_BYTES,
  RunHost,
  ScriptedGate,
  ScriptedWorker,
} from "../src/index.js";

const RUN_ID = "demo-run";
const POLICY: RunPolicy = { maxConcurrent: 3, maxAttemptsPerNode: 2 };

const demoGraph: GraphSpec = {
  schemaVersion: 1,
  id: "demo-graph",
  runId: RUN_ID,
  depth: 0,
  revision: 1,
  nodes: [
    {
      id: "implement",
      role: "implementer",
      objective: "Produce the requested patch",
      acceptanceCriteria: ["Patch meets the task contract"],
      limits: { maxTokens: 8000, maxToolCalls: 40 },
    },
    {
      id: "verify",
      role: "verifier",
      objective: "Collect reproducible verification evidence",
      acceptanceCriteria: ["Required checks pass against the candidate revision"],
      limits: { maxTokens: 4000, maxToolCalls: 20 },
    },
    {
      id: "review",
      role: "reviewer",
      objective: "Review the verified candidate",
      acceptanceCriteria: ["Acceptance criteria and evidence have been reviewed"],
      limits: { maxTokens: 4000, maxToolCalls: 20 },
    },
  ],
  edges: [
    { from: "implement", to: "verify", condition: "result_ready" },
    { from: "verify", to: "review", condition: "accepted" },
  ],
};

function counter(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `evt-${n}`;
  };
}

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for: ${label}`);
}

/** Runs `body` with a fresh mkdtemp directory and removes exactly that directory afterwards. */
async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "file-journal-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true });
  }
}

function event(runId: string, n: number): JournalEvent {
  return {
    type: "attempt_dispatched",
    schemaVersion: 1,
    eventId: `${runId}-evt-${n}`,
    runId,
    at: "2026-01-01T00:00:00.000Z",
    nodeId: "implement",
    attemptId: `attempt-${n}`,
    fencingToken: n,
  };
}

async function lines(path: string): Promise<string[]> {
  const text = await readFile(path, "utf8");
  return text.split("\n").slice(0, -1);
}

function same(actual: readonly JournalEvent[], expected: readonly JournalEvent[]): void {
  assert.equal(canonicalJson(actual), canonicalJson(expected));
}

test("round trip keeps events and numbers lines", async () => {
  await withDir(async (dir) => {
    const store = new FileJournalStore(join(dir, "journals"));
    const events = [event("r", 1), event("r", 2), event("r", 3)];
    for (const e of events) await store.append(e);
    const read = await store.read("r");
    same(read.events, events);
    assert.equal(read.tornTail, false);
    const written = await lines(store.pathFor("r"));
    assert.deepEqual(
      written.map((line) => (JSON.parse(line) as { seq: number }).seq),
      [1, 2, 3],
    );
  });
});

test("runs are isolated and run ids cannot escape the directory", async () => {
  await withDir(async (dir) => {
    const store = new FileJournalStore(dir);
    await store.append(event("a", 1));
    await store.append(event("b", 1));
    await store.append(event("b", 2));
    assert.equal((await store.read("a")).events.length, 1);
    assert.equal((await store.read("b")).events.length, 2);
    assert.notEqual(store.pathFor("a"), store.pathFor("b"));
    const odd = "../x/y:z";
    assert.equal(dirname(store.pathFor(odd)), dir);
    await store.append(event(odd, 1));
    same((await store.read(odd)).events, [event(odd, 1)]);
  });
});

test("a missing file reads as empty", async () => {
  await withDir(async (dir) => {
    assert.deepEqual(await new FileJournalStore(dir).read("nope"), { events: [], tornTail: false });
  });
});

test("a torn tail is dropped on read and truncated before the next append", async () => {
  await withDir(async (dir) => {
    const store = new FileJournalStore(dir);
    await store.append(event("r", 1));
    await store.append(event("r", 2));
    await appendFile(store.pathFor("r"), '{"seq":3,"digest":"sha256:ab', "utf8");
    const torn = await store.read("r");
    assert.equal(torn.events.length, 2);
    assert.equal(torn.tornTail, true);

    const second = new FileJournalStore(dir);
    await second.append(event("r", 3));
    const read = await second.read("r");
    same(read.events, [event("r", 1), event("r", 2), event("r", 3)]);
    assert.equal(read.tornTail, false);
    assert.equal((await lines(second.pathFor("r"))).length, 3);
  });
});

test("a complete last line that is invalid is corrupt, never dropped", async () => {
  async function lastLine(record: unknown): Promise<unknown> {
    let caught: unknown;
    await withDir(async (dir) => {
      const store = new FileJournalStore(dir);
      await store.append(event("r", 1));
      await appendFile(store.pathFor("r"), `${JSON.stringify(record)}\n`, "utf8");
      try {
        await store.read("r");
      } catch (error) {
        caught = error;
      }
      await assert.rejects(new FileJournalStore(dir).append(event("r", 2)), JournalCorruptError);
    });
    return caught;
  }

  const wrongDigest = await lastLine({ seq: 2, digest: "sha256:00", event: event("r", 2) });
  assert.ok(wrongDigest instanceof JournalCorruptError);
  assert.equal(wrongDigest.line, 2);

  const wrongSeq = await lastLine({ seq: 7, digest: digest(event("r", 2)), event: event("r", 2) });
  assert.ok(wrongSeq instanceof JournalCorruptError);

  const other = event("other", 2);
  const foreign = await lastLine({ seq: 2, digest: digest(other), event: other });
  assert.ok(foreign instanceof JournalCorruptError);
});

test("corruption before the last line throws JournalCorruptError", async () => {
  async function corrupt(edit: (records: Record<string, unknown>[]) => void): Promise<JournalCorruptError> {
    let caught: unknown;
    await withDir(async (dir) => {
      const store = new FileJournalStore(dir);
      await store.append(event("r", 1));
      await store.append(event("r", 2));
      const records = (await lines(store.pathFor("r"))).map((line) => JSON.parse(line) as Record<string, unknown>);
      edit(records);
      await writeFile(store.pathFor("r"), records.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
      try {
        await store.read("r");
      } catch (error) {
        caught = error;
      }
    });
    assert.ok(caught instanceof JournalCorruptError, "expected JournalCorruptError");
    return caught;
  }

  const badDigest = await corrupt((records) => {
    const first = records[0];
    if (first !== undefined) first.digest = "sha256:00";
  });
  assert.equal(badDigest.line, 1);
  assert.equal(badDigest.runId, "r");

  const gap = await corrupt((records) => {
    const first = records[0];
    if (first !== undefined) first.seq = 5;
  });
  assert.equal(gap.line, 1);

  const foreign = await corrupt((records) => {
    const other = event("other", 1);
    records[0] = { seq: 1, digest: digest(other), event: other };
  });
  assert.equal(foreign.line, 1);
});

test("concurrent appends keep call order", async () => {
  await withDir(async (dir) => {
    const store = new FileJournalStore(dir);
    const events = Array.from({ length: 10 }, (_, i) => event("r", i + 1));
    await Promise.all(events.map((e) => store.append(e)));
    same((await store.read("r")).events, events);
    const seqs = (await lines(store.pathFor("r"))).map((line) => (JSON.parse(line) as { seq: number }).seq);
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

function ports(journal: FileJournalStore, worker: ScriptedWorker, nextId: () => string): HostPorts {
  return {
    journal,
    worker,
    gate: new ScriptedGate(),
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
    newEventId: nextId,
  };
}

test("the host resumes on the file store after a restart", async () => {
  await withDir(async (dir) => {
    const nextId = counter();
    const oldWorker = new ScriptedWorker({ mode: "manual" });
    await RunHost.start(ports(new FileJournalStore(dir), oldWorker, nextId), demoGraph, POLICY);
    await until(() => oldWorker.started.length === 1, "implement started");
    const first = oldWorker.started[0];
    assert.ok(first !== undefined);

    const store = new FileJournalStore(dir);
    const resumed = await RunHost.resume(ports(store, new ScriptedWorker(), nextId), RUN_ID);
    assert.equal(await resumed.completion, "succeeded");

    const { events } = await store.read(RUN_ID);
    const expired = events.filter((e) => e.type === "lease_expired");
    assert.ok(expired.some((e) => e.attemptId === first.attemptId));
    const replayed = replay(events);
    assert.deepEqual(replayed.rejections, []);
    assert.equal(canonicalJson(replayed.state), canonicalJson(resumed.state));
  });
});

test("resume survives a torn tail and leaves only valid lines", async () => {
  await withDir(async (dir) => {
    const nextId = counter();
    const oldWorker = new ScriptedWorker({ mode: "manual" });
    await RunHost.start(ports(new FileJournalStore(dir), oldWorker, nextId), demoGraph, POLICY);
    await until(() => oldWorker.started.length === 1, "implement started");
    await appendFile(new FileJournalStore(dir).pathFor(RUN_ID), '{"seq":99,"dig', "utf8");

    const store = new FileJournalStore(dir);
    const resumed = await RunHost.resume(ports(store, new ScriptedWorker(), nextId), RUN_ID);
    assert.equal(resumed.recovery.tornTail, true);
    assert.equal(await resumed.completion, "succeeded");

    const read = await store.read(RUN_ID);
    assert.equal(read.tornTail, false);
    const written = await lines(store.pathFor(RUN_ID));
    assert.equal(written.length, read.events.length);
    assert.equal(canonicalJson(replay(read.events).state), canonicalJson(resumed.state));
  });
});

test("run ids that differ only by case get different files", async () => {
  await withDir(async (dir) => {
    const store = new FileJournalStore(dir);
    assert.notEqual(store.pathFor("Run").toLowerCase(), store.pathFor("run").toLowerCase());
    await store.append(event("Run", 1));
    await store.append(event("run", 1));
    await store.append(event("run", 2));
    same((await store.read("Run")).events, [event("Run", 1)]);
    same((await store.read("run")).events, [event("run", 1), event("run", 2)]);
    for (const id of ["..", "/", "a/../b"]) assert.equal(dirname(store.pathFor(id)), dir);
    await store.append(event("..", 1));
    await store.append(event("/", 1));
    same((await store.read("..")).events, [event("..", 1)]);
    same((await store.read("/")).events, [event("/", 1)]);
  });
});

test("a symlink at the run's path is never followed", { skip: process.platform === "win32" }, async () => {
  await withDir(async (dir) => {
    const store = new FileJournalStore(join(dir, "journals"));
    await store.append(event("other", 1));
    const target = join(dir, "target.txt");
    await writeFile(target, "untouched\n", "utf8");
    await symlink(target, store.pathFor("r"));
    await assert.rejects(store.read("r"));
    await assert.rejects(store.append(event("r", 1)));
    assert.equal(await readFile(target, "utf8"), "untouched\n");
  });
});

test("records are bounded by MAX_RECORD_BYTES", async () => {
  await withDir(async (dir) => {
    const store = new FileJournalStore(dir);
    const nearLimit: JournalEvent = {
      type: "result_proposed",
      schemaVersion: 1,
      eventId: "evt-1",
      runId: "r",
      at: "2026-01-01T00:00:00.000Z",
      attemptId: "attempt-1",
      fencingToken: 1,
      proposalDigest: "d".repeat(255),
    };
    await store.append(nearLimit);
    same((await store.read("r")).events, [nearLimit]);

    const huge: JournalEvent = {
      type: "run_started",
      schemaVersion: 1,
      eventId: "evt-2",
      runId: "big",
      at: "2026-01-01T00:00:00.000Z",
      graph: {
        ...demoGraph,
        runId: "big",
        nodes: demoGraph.nodes.map((node) => ({ ...node, objective: "x".repeat(MAX_RECORD_BYTES) })),
      },
      policy: POLICY,
    };
    await assert.rejects(store.append(huge), /larger than/);
    assert.deepEqual(await store.read("big"), { events: [], tornTail: false });

    await appendFile(store.pathFor("long"), `${"x".repeat(MAX_RECORD_BYTES + 1)}\n`, "utf8");
    await assert.rejects(store.read("long"), /MAX_RECORD_BYTES/);
    await appendFile(store.pathFor("longtail"), "x".repeat(MAX_RECORD_BYTES + 1), "utf8");
    await assert.rejects(store.read("longtail"), JournalCorruptError);
  });
});
