import assert from "node:assert/strict";
import test from "node:test";

import {
  type ArtifactStore,
  type CheckProfile,
  type CheckReceipt,
  type CodingSession,
  digest,
  type EvidenceRecord,
  type EvidenceStore,
  type NodeSpec,
  type ResultProposal,
  type ReviewReceipt,
  type Role,
  type SessionEvent,
  type WorkerAssignment,
  type WorkerOutcome,
} from "@auto-pi-lot/core";

import {
  CHECKER_TOOLS,
  READER_TOOLS,
  type SessionOpenRequest,
  SessionWorker,
  type SessionWorkerOptions,
  SYSTEM_PROMPT,
  USAGE_UNKNOWN_LIMITATION,
  WRITER_TOOLS,
} from "../src/index.js";

class MemoryEvidence implements EvidenceStore {
  readonly records = new Map<string, EvidenceRecord>();
  async put(record: EvidenceRecord): Promise<string> {
    this.records.set(record.id, record);
    return record.id;
  }
  async get(id: string): Promise<EvidenceRecord | null> {
    return this.records.get(id) ?? null;
  }
  async listForRun(runId: string): Promise<readonly EvidenceRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.runId === runId)
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  ofKind<K extends EvidenceRecord["kind"]>(kind: K): Extract<EvidenceRecord, { kind: K }>[] {
    return [...this.records.values()].filter((r): r is Extract<EvidenceRecord, { kind: K }> => r.kind === kind);
  }
}

class MemoryArtifacts implements ArtifactStore {
  readonly blobs = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array): Promise<string> {
    const id = digest(Buffer.from(bytes).toString("base64"));
    this.blobs.set(id, bytes);
    return id;
  }
  async get(id: string): Promise<Uint8Array | null> {
    return this.blobs.get(id) ?? null;
  }
}

type Script = (session: ScriptedSession) => Promise<void> | void;

class ScriptedSession implements CodingSession {
  readonly prompts: string[] = [];
  aborts = 0;
  disposed = 0;
  readonly #listeners = new Set<(event: SessionEvent) => void>();
  readonly #turns: Script[];
  #release: (() => void) | null = null;

  constructor(turns: Script[]) {
    this.#turns = turns;
  }
  emit(...events: SessionEvent[]): void {
    for (const event of events) for (const listener of [...this.#listeners]) listener(event);
  }
  /** Resolves once abort() has been called. */
  waitForAbort(): Promise<void> {
    if (this.aborts > 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.#release = resolve;
    });
  }
  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    const turn = this.#turns.shift();
    if (turn !== undefined) await turn(this);
  }
  async abort(): Promise<void> {
    this.aborts += 1;
    this.#release?.();
  }
  dispose(): void {
    this.disposed += 1;
  }
  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

const say = (text: string): SessionEvent => ({ type: "assistant_message", text, truncated: false });
const settled = (reason: "completed" | "aborted" | "error"): SessionEvent => ({ type: "settled", reason });
const toolCall = (n: number): SessionEvent => ({ type: "tool_call", callId: `c${n}`, toolName: "read" });
const reported = (inputTokens: number, outputTokens: number): SessionEvent => ({
  type: "usage",
  qualification: "reported",
  source: "turn",
  inputTokens,
  outputTokens,
});
const workJson = (extra: object = {}): string =>
  `Done.\n\`\`\`json\n${JSON.stringify({ summary: "Implemented it", claims: ["works"], limitations: ["none known"], ...extra })}\n\`\`\``;
const reviewJson = (): string =>
  `\`\`\`json\n${JSON.stringify({
    verdicts: [
      { criterion: "Patch meets the task contract", verdict: "pass", evidence: "read the diff" },
      { criterion: "Edge cases", verdict: "unclear", evidence: "no tests" },
    ],
    limitations: ["did not run the suite"],
  })}\n\`\`\``;
const completeWith =
  (text: string): Script =>
  (session) => {
    session.emit(say(text), settled("completed"));
  };

const RUN_ID = "run-1";
const UNIT: CheckProfile = { id: "unit", command: "npm", args: ["test"] };

function assignmentFor(
  role: Role,
  extra: Partial<WorkerAssignment> = {},
  node: Partial<NodeSpec> = {},
): WorkerAssignment {
  return {
    runId: RUN_ID,
    graphId: "graph-1",
    graphRevision: 2,
    nodeId: "node-1",
    attemptId: "attempt-1",
    fencingToken: 1,
    node: {
      id: "node-1",
      role,
      objective: "Add the frobnicator",
      acceptanceCriteria: ["Patch meets the task contract"],
      limits: { maxTokens: 10_000, maxToolCalls: 20 },
      ...node,
    },
    consumes: {},
    verifies: [],
    producers: [],
    repairOf: null,
    ...extra,
  };
}

interface Harness {
  readonly worker: SessionWorker;
  readonly evidence: MemoryEvidence;
  readonly artifacts: MemoryArtifacts;
  readonly session: ScriptedSession;
  readonly opened: SessionOpenRequest[];
  readonly logs: string[];
  readonly fingerprints: string[];
  readonly checksRun: { profileId: string; sourceDigest: string; attemptId: string }[];
}

function harness(
  turns: Script[],
  options: {
    fingerprints?: string[];
    checks?: CheckProfile[];
    evidence?: MemoryEvidence;
    runCheck?: SessionWorkerOptions["runCheck"];
  } = {},
): Harness {
  const session = new ScriptedSession(turns);
  const evidence = options.evidence ?? new MemoryEvidence();
  const artifacts = new MemoryArtifacts();
  const opened: SessionOpenRequest[] = [];
  const logs: string[] = [];
  const queue = [...(options.fingerprints ?? ["sha256:base", "sha256:after"])];
  const fingerprints: string[] = [];
  const checksRun: Harness["checksRun"] = [];
  const settings: SessionWorkerOptions = {
    workspace: "/virtual/workspace",
    checks: options.checks ?? [UNIT],
    openSession: async (request) => {
      opened.push(request);
      return session;
    },
    evidence,
    artifacts,
    clock: () => new Date(Date.UTC(2026, 9, 8, 12, 0, 0)),
    fingerprint: async () => {
      const value = queue.length > 1 ? (queue.shift() as string) : (queue[0] as string);
      fingerprints.push(value);
      return value;
    },
    runCheck:
      options.runCheck ??
      (async (profile, input) => {
        checksRun.push({ profileId: profile.id, sourceDigest: input.sourceDigest, attemptId: input.attemptId });
        const receipt: Omit<CheckReceipt, "id"> = {
          kind: "check",
          schemaVersion: 1,
          runId: input.runId,
          attemptId: input.attemptId,
          profileId: profile.id,
          profileVersion: digest(profile),
          executable: profile.command,
          args: profile.args,
          environmentDigest: "sha256:env",
          inputDigest: digest({ profileId: profile.id, sourceDigest: input.sourceDigest }),
          sourceDigest: input.sourceDigest,
          exitCode: profile.id === "failing" ? 1 : 0,
          outcome: profile.id === "failing" ? "fail" : "pass",
          logArtifactIds: [],
          startedAt: "2026-10-08T12:00:00.000Z",
          finishedAt: "2026-10-08T12:00:00.000Z",
        };
        return { ...receipt, id: digest(receipt) };
      }),
    log: (line) => logs.push(line),
  };
  return { worker: new SessionWorker(settings), evidence, artifacts, session, opened, logs, fingerprints, checksRun };
}

/** Starts an attempt and returns every outcome reported, after letting stray callbacks run. */
async function run(h: Harness, assignment: WorkerAssignment): Promise<WorkerOutcome[]> {
  const outcomes: WorkerOutcome[] = [];
  let first!: () => void;
  const firstReport = new Promise<void>((resolve) => {
    first = resolve;
  });
  h.worker.start(assignment, (outcome) => {
    outcomes.push(outcome);
    first();
  });
  await firstReport;
  await new Promise((resolve) => setImmediate(resolve));
  return outcomes;
}

function failedWith(outcomes: WorkerOutcome[], category: string): void {
  assert.deepEqual(outcomes, [{ type: "failed", category }]);
}

test("a deadline aborts a stalled prompt, disposes it and reports exactly one failure", async () => {
  const h = harness([
    async (session) => {
      await session.waitForAbort();
      session.emit(say(workJson()), settled("completed"));
    },
  ]);
  failedWith(
    await run(
      h,
      assignmentFor(
        "implementer",
        {},
        {
          limits: { maxTokens: 1000, maxToolCalls: 10, timeoutMs: 30 },
        },
      ),
    ),
    "deadline_exceeded",
  );
  assert.equal(h.session.aborts, 1);
  assert.equal(h.session.disposed, 1);
  assert.equal(h.evidence.ofKind("proposal").length, 0);
});

test("a deadline during session setup disposes the late session without prompting", async () => {
  const s = new ScriptedSession([]);
  const worker = new SessionWorker({
    workspace: "/virtual/workspace",
    checks: [],
    evidence: new MemoryEvidence(),
    artifacts: new MemoryArtifacts(),
    fingerprint: async () => "sha256:base",
    openSession: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return s;
    },
  });
  const outcome = await new Promise<WorkerOutcome>((resolve) =>
    worker.start(
      assignmentFor(
        "implementer",
        {},
        {
          limits: { maxTokens: 1000, maxToolCalls: 10, timeoutMs: 10 },
        },
      ),
      resolve,
    ),
  );
  assert.deepEqual(outcome, { type: "failed", category: "deadline_exceeded" });
  assert.equal(s.prompts.length, 0);
  assert.equal(s.disposed, 1);
});

test("a deadline interrupts a check and cannot publish its late success", async () => {
  const h = harness([completeWith(workJson())], {
    runCheck: async (_profile, input) => {
      await new Promise<void>((resolve) => input.signal?.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("check aborted");
    },
  });
  failedWith(
    await run(
      h,
      assignmentFor(
        "implementer",
        {},
        {
          checks: ["unit"],
          limits: { maxTokens: 1000, maxToolCalls: 10, timeoutMs: 30 },
        },
      ),
    ),
    "deadline_exceeded",
  );
  assert.equal(h.session.disposed, 1);
  assert.equal(h.evidence.ofKind("proposal").length, 0);
});

test("check mutations invalidate evidence and prevent remaining checks", async () => {
  const h = harness([completeWith(workJson())], { fingerprints: ["sha256:base", "sha256:result", "sha256:mutated"] });
  failedWith(await run(h, assignmentFor("implementer", {}, { checks: ["unit", "unit"] })), "effect_uncertain");
  assert.equal(h.checksRun.length, 1);
  assert.equal(h.evidence.ofKind("proposal").length, 0);
});

test("a reviewer refuses a candidate from a different workspace revision before opening a session", async () => {
  const h = harness([], { evidence: await candidateEvidence(), fingerprints: ["sha256:drifted"] });
  failedWith(await run(h, checkerAssignment("reviewer")), "effect_uncertain");
  assert.equal(h.opened.length, 0);
});

test("start returns synchronously and reports later", async () => {
  const h = harness([completeWith(workJson())]);
  let reports = 0;
  h.worker.start(assignmentFor("implementer"), () => {
    reports += 1;
  });
  assert.equal(reports, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reports, 1);
});

test("an implementer's happy path records checks and a proposal", async () => {
  const h = harness([completeWith(workJson())], { fingerprints: ["sha256:base", "sha256:after"] });
  const assignment = assignmentFor("implementer", {}, { checks: ["unit"] });
  const outcomes = await run(h, assignment);

  const proposals = h.evidence.ofKind("proposal");
  assert.equal(proposals.length, 1);
  const proposal = proposals[0] as ResultProposal;
  assert.deepEqual(outcomes, [{ type: "result", proposalDigest: proposal.id }]);
  assert.equal(proposal.baseRevision, "sha256:base");
  assert.equal(proposal.resultRevision, "sha256:after");
  assert.deepEqual(proposal.requestedChecks, ["unit"]);
  assert.equal(proposal.summary, "Implemented it");
  assert.deepEqual(proposal.claims, ["works"]);
  assert.deepEqual(proposal.limitations, ["none known"]);
  assert.equal(proposal.graphRevision, 2);
  assert.equal(proposal.inputFingerprint, digest({ consumes: {}, baseRevision: "sha256:base" }));

  assert.equal(h.opened.length, 1);
  assert.deepEqual(h.opened[0]?.tools, WRITER_TOOLS);
  assert.equal(h.opened[0]?.cwd, "/virtual/workspace");
  assert.equal(h.opened[0]?.systemPrompt, SYSTEM_PROMPT);
  assert.match(h.session.prompts[0] ?? "", /Add the frobnicator/);
  assert.match(h.session.prompts[0] ?? "", /unit: `npm test`/);

  assert.deepEqual(h.checksRun, [{ profileId: "unit", sourceDigest: "sha256:after", attemptId: "attempt-1" }]);
  assert.equal(h.evidence.ofKind("check").length, 1);
  assert.deepEqual(
    proposal.checkReceiptIds,
    h.evidence.ofKind("check").map((check) => check.id),
  );
  assert.equal(h.session.disposed, 1);
});

test("a failing check does not stop the remaining checks or the proposal", async () => {
  const failing: CheckProfile = { id: "failing", command: "false", args: [] };
  const h = harness([completeWith(workJson())], { checks: [failing, UNIT] });
  const outcomes = await run(h, assignmentFor("implementer", {}, { checks: ["failing", "unit"] }));
  assert.deepEqual(
    h.checksRun.map((c) => c.profileId),
    ["failing", "unit"],
  );
  assert.equal(outcomes[0]?.type, "result");
  const proposal = h.evidence.ofKind("proposal")[0] as ResultProposal;
  const receipts = h.evidence.ofKind("check");
  assert.deepEqual(
    proposal.checkReceiptIds,
    ["failing", "unit"].map((profileId) => receipts.find((receipt) => receipt.profileId === profileId)?.id),
  );
});

test("a planner runs its declared checks and lists the receipts", async () => {
  const h = harness([completeWith(workJson())], { fingerprints: ["sha256:same"] });
  const outcomes = await run(h, assignmentFor("planner", {}, { checks: ["unit"] }));
  assert.equal(outcomes[0]?.type, "result");
  assert.deepEqual(h.checksRun, [{ profileId: "unit", sourceDigest: "sha256:same", attemptId: "attempt-1" }]);
  const proposal = h.evidence.ofKind("proposal")[0] as ResultProposal;
  assert.deepEqual(
    proposal.checkReceiptIds,
    h.evidence.ofKind("check").map((check) => check.id),
  );
  assert.equal(proposal.checkReceiptIds.length, 1);
});

test("a reviewer's happy path records a review receipt bound to the candidate", async () => {
  const evidence = new MemoryEvidence();
  const candidate: ResultProposal = {
    kind: "proposal",
    schemaVersion: 1,
    id: "sha256:candidate",
    runId: RUN_ID,
    graphId: "graph-1",
    graphRevision: 2,
    nodeId: "produce",
    attemptId: "attempt-0",
    summary: "Built it",
    outputArtifactIds: [],
    claims: ["built"],
    limitations: [],
    requestedChecks: [],
    checkReceiptIds: [],

    inputFingerprint: "sha256:in",
    resultRevision: "sha256:same",
  };
  await evidence.put(candidate);
  const h = harness([completeWith(reviewJson())], { evidence, fingerprints: ["sha256:same"] });
  const outcomes = await run(
    h,
    assignmentFor("reviewer", {
      consumes: { produce: "attempt-0" },
      verifies: ["produce"],
      producers: [
        {
          id: "produce",
          role: "implementer",
          objective: "Produce",
          acceptanceCriteria: ["Patch meets the task contract", "Edge cases"],
          limits: { maxTokens: 1, maxToolCalls: 1 },
        },
      ],
    }),
  );

  const reviews = h.evidence.ofKind("review");
  assert.equal(reviews.length, 1);
  const review = reviews[0] as ReviewReceipt;
  assert.equal(review.candidateDigest, "sha256:candidate");
  assert.equal(review.candidateAttemptId, "attempt-0");
  assert.equal(review.reviewerAttemptId, "attempt-1");
  assert.deepEqual(review.verdicts, [
    { criterion: "Patch meets the task contract", verdict: "pass", evidenceIds: [], note: "read the diff" },
    { criterion: "Edge cases", verdict: "unclear", evidenceIds: [], note: "no tests" },
  ]);
  assert.deepEqual(review.limitations, ["did not run the suite"]);

  const proposal = h.evidence.ofKind("proposal").find((p) => p.attemptId === "attempt-1") as ResultProposal;
  assert.deepEqual(outcomes, [{ type: "result", proposalDigest: proposal.id }]);
  assert.deepEqual(proposal.outputArtifactIds, [review.id]);
  assert.equal(proposal.summary, "Review of produce: 1 pass, 0 fail, 1 unclear");
  assert.deepEqual(h.opened[0]?.tools, READER_TOOLS);
  assert.match(h.session.prompts[0] ?? "", /CANDIDATE UNDER REVIEW/);
  assert.equal(h.checksRun.length, 0);
  assert.deepEqual(proposal.checkReceiptIds, []);
});

test("a verifier gets checker tools", async () => {
  const evidence = new MemoryEvidence();
  await evidence.put({
    kind: "proposal",
    schemaVersion: 1,
    id: "sha256:candidate",
    runId: RUN_ID,
    graphId: "graph-1",
    graphRevision: 2,
    nodeId: "produce",
    attemptId: "attempt-0",
    summary: "Built it",
    outputArtifactIds: [],
    claims: [],
    limitations: [],
    requestedChecks: [],
    checkReceiptIds: [],

    inputFingerprint: "sha256:in",
    resultRevision: "sha256:same",
  });
  const h = harness([completeWith(reviewJson())], { evidence, fingerprints: ["sha256:same"] });
  await run(h, assignmentFor("verifier", { consumes: { produce: "attempt-0" }, verifies: ["produce"] }));
  assert.deepEqual(h.opened[0]?.tools, CHECKER_TOOLS);
});

test("a malformed report is repaired on the second prompt", async () => {
  const h = harness([completeWith("I am finished, no block."), completeWith(workJson())]);
  const outcomes = await run(h, assignmentFor("implementer"));
  assert.equal(outcomes[0]?.type, "result");
  assert.equal(h.session.prompts.length, 2);
  assert.match(h.session.prompts[1] ?? "", /exactly one ```json block/);
});

test("a report that stays malformed is schema_invalid", async () => {
  const h = harness([completeWith("nope"), completeWith('```json\n{"summary": 5}\n```')]);
  failedWith(await run(h, assignmentFor("implementer")), "schema_invalid");
  assert.equal(h.session.prompts.length, 2);
  assert.equal(h.session.disposed, 1);
  assert.equal(h.evidence.records.size, 0);
});

test("a stale report is not reused by the repair prompt", async () => {
  const h = harness([completeWith(workJson()), (session) => session.emit(settled("completed"))]);
  const outcomes = await run(h, assignmentFor("implementer"));
  assert.equal(outcomes[0]?.type, "result");
  assert.equal(h.session.prompts.length, 1);
});

test("exceeding the tool-call limit aborts with budget_exhausted", async () => {
  const h = harness([
    async (session) => {
      session.emit(toolCall(1), toolCall(2), toolCall(3));
      await session.waitForAbort();
      session.emit(settled("aborted"));
    },
  ]);
  failedWith(
    await run(h, assignmentFor("implementer", {}, { limits: { maxTokens: 10_000, maxToolCalls: 2 } })),
    "budget_exhausted",
  );
  assert.equal(h.session.aborts, 1);
  assert.equal(h.session.disposed, 1);
});

test("exactly the tool-call limit is allowed", async () => {
  const h = harness([
    (session) => {
      session.emit(toolCall(1), toolCall(2), say(workJson()), settled("completed"));
    },
  ]);
  const outcomes = await run(h, assignmentFor("implementer", {}, { limits: { maxTokens: 10_000, maxToolCalls: 2 } }));
  assert.equal(outcomes[0]?.type, "result");
  assert.equal(h.session.aborts, 0);
});

test("exceeding reported tokens aborts with budget_exhausted", async () => {
  const h = harness([
    async (session) => {
      session.emit(reported(400, 300), reported(300, 300));
      await session.waitForAbort();
      session.emit(settled("aborted"));
    },
  ]);
  failedWith(
    await run(h, assignmentFor("implementer", {}, { limits: { maxTokens: 1000, maxToolCalls: 20 } })),
    "budget_exhausted",
  );
  assert.equal(h.session.aborts, 1);
});

test("unknown usage adds a limitation and does not fail the attempt", async () => {
  const h = harness([
    (session) => {
      session.emit({ type: "usage", qualification: "unknown", source: "turn" }, say(workJson()), settled("completed"));
    },
  ]);
  const outcomes = await run(h, assignmentFor("implementer"));
  assert.equal(outcomes[0]?.type, "result");
  const proposal = h.evidence.ofKind("proposal")[0] as ResultProposal;
  assert.deepEqual(proposal.limitations, ["none known", USAGE_UNKNOWN_LIMITATION]);
});

test("a reader that changed the tree fails without proposing evidence", async () => {
  const h = harness([completeWith(workJson())], { fingerprints: ["sha256:base", "sha256:changed"] });
  failedWith(await run(h, assignmentFor("explorer")), "effect_uncertain");
  assert.equal(h.evidence.ofKind("proposal").length, 0);
  assert.equal(h.session.disposed, 1);
});

test("a reader that left the tree alone succeeds", async () => {
  const h = harness([completeWith(workJson())], { fingerprints: ["sha256:same"] });
  const outcomes = await run(h, assignmentFor("explorer"));
  assert.equal(outcomes[0]?.type, "result");
  assert.deepEqual(h.opened[0]?.tools, READER_TOOLS);
  const proposal = h.evidence.ofKind("proposal")[0] as ResultProposal;
  assert.deepEqual(proposal.limitations, ["none known"]);
});

test("an unknown check profile is policy_denied before a session opens", async () => {
  const h = harness([completeWith(workJson())]);
  failedWith(await run(h, assignmentFor("implementer", {}, { checks: ["missing"] })), "policy_denied");
  assert.equal(h.opened.length, 0);
});

test("a checker must have exactly one candidate proposal", async () => {
  const evidence = new MemoryEvidence();
  const two = harness([completeWith(reviewJson())], { evidence });
  failedWith(
    await run(two, assignmentFor("verifier", { consumes: { a: "x", b: "y" }, verifies: ["a", "b"] })),
    "policy_denied",
  );
  const missing = harness([completeWith(reviewJson())], { evidence });
  failedWith(await run(missing, assignmentFor("verifier", { consumes: { a: "x" }, verifies: ["a"] })), "policy_denied");
  assert.equal(two.opened.length + missing.opened.length, 0);
});

test("cancel during the prompt reports stopped once and disposes the session", async () => {
  const h = harness([
    async (session) => {
      await session.waitForAbort();
      session.emit(settled("aborted"));
    },
  ]);
  const outcomes: WorkerOutcome[] = [];
  h.worker.start(assignmentFor("implementer"), (outcome) => outcomes.push(outcome));
  while (h.session.prompts.length === 0) await new Promise((resolve) => setImmediate(resolve));
  h.worker.cancel("attempt-1");
  h.worker.cancel("attempt-1");
  while (outcomes.length === 0) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(outcomes, [{ type: "stopped" }]);
  assert.ok(h.session.aborts >= 1);
  assert.equal(h.session.disposed, 1);
  h.worker.cancel("attempt-1");
  h.worker.cancel("unknown");
});

test("a session error is worker_crashed", async () => {
  const h = harness([
    (session) => {
      session.emit({ type: "error", message: "provider down" }, settled("error"));
    },
  ]);
  failedWith(await run(h, assignmentFor("implementer")), "worker_crashed");
  assert.equal(h.session.disposed, 1);
  assert.ok(h.logs.some((line) => line.includes("provider down")));
});

test("an abort the worker did not ask for is worker_crashed", async () => {
  const h = harness([(session) => session.emit(settled("aborted"))]);
  failedWith(await run(h, assignmentFor("implementer")), "worker_crashed");
});

test("a prompt that throws is worker_crashed and the session is disposed", async () => {
  const h = harness([
    () => {
      throw new Error("socket closed");
    },
  ]);
  failedWith(await run(h, assignmentFor("implementer")), "worker_crashed");
  assert.equal(h.session.disposed, 1);
});

test("an outcome is delivered once even if the session settles twice", async () => {
  const h = harness([
    (session) => {
      session.emit(say(workJson()), settled("completed"), settled("completed"), settled("aborted"));
    },
  ]);
  const outcomes: WorkerOutcome[] = [];
  h.worker.start(assignmentFor("implementer"), (outcome) => outcomes.push(outcome));
  // A duplicate dispatch of an attempt that is still running is ignored.
  let extra = 0;
  h.worker.start(assignmentFor("implementer"), () => {
    extra += 1;
  });
  while (outcomes.length === 0) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outcomes.length, 1);
  assert.equal(extra, 0);
  assert.equal(h.opened.length, 1);
});

test("repair evidence reaches the packet with the log tail", async () => {
  const evidence = new MemoryEvidence();
  const h = harness([completeWith(workJson())], { evidence });
  const logId = await h.artifacts.put(Buffer.from(`${"noise\n".repeat(1000)}FINAL FAILURE LINE\n`));
  const receipt: CheckReceipt = {
    kind: "check",
    schemaVersion: 1,
    id: "sha256:old-check",
    runId: RUN_ID,
    attemptId: "attempt-0",
    profileId: "unit",
    profileVersion: "sha256:v",
    executable: "npm",
    args: ["test"],
    environmentDigest: "sha256:e",
    inputDigest: "sha256:i",
    sourceDigest: "sha256:s",
    exitCode: 1,
    outcome: "fail",
    logArtifactIds: [logId],
    startedAt: "2026-10-08T12:00:00.000Z",
    finishedAt: "2026-10-08T12:00:00.000Z",
  };
  await evidence.put(receipt);
  await run(
    h,
    assignmentFor("implementer", { repairOf: { attemptId: "attempt-0", receiptIds: ["sha256:old-check"] } }),
  );
  const packet = h.session.prompts[0] ?? "";
  assert.match(packet, /Your previous attempt attempt-0 was rejected/);
  assert.match(packet, /FINAL FAILURE LINE/);
  assert.ok(packet.length < 8000);
});

test("log lines never carry long model text", async () => {
  const h = harness([
    (session) => {
      session.emit({ type: "error", message: "x".repeat(1500) }, settled("error"));
    },
  ]);
  await run(h, assignmentFor("implementer"));
  assert.ok(h.logs.length > 0);
  for (const line of h.logs) assert.ok(line.length <= 200, line);
});

const PRODUCER_SPEC: NodeSpec = {
  id: "produce",
  role: "implementer",
  objective: "Produce",
  acceptanceCriteria: ["Alpha", "Beta"],
  limits: { maxTokens: 1, maxToolCalls: 1 },
};

async function candidateEvidence(): Promise<MemoryEvidence> {
  const evidence = new MemoryEvidence();
  await evidence.put({
    kind: "proposal",
    schemaVersion: 1,
    id: "sha256:candidate",
    runId: RUN_ID,
    graphId: "graph-1",
    graphRevision: 2,
    nodeId: "produce",
    attemptId: "attempt-0",
    summary: "Built it",
    outputArtifactIds: [],
    claims: [],
    limitations: [],
    requestedChecks: [],
    checkReceiptIds: [],
    inputFingerprint: "sha256:in",
    resultRevision: "sha256:same",
  });
  return evidence;
}

const checkerAssignment = (role: Role): WorkerAssignment =>
  assignmentFor(role, { consumes: { produce: "attempt-0" }, verifies: ["produce"], producers: [PRODUCER_SPEC] });

const verdictsJson = (criteria: string[]): string =>
  `\`\`\`json\n${JSON.stringify({
    verdicts: criteria.map((criterion) => ({ criterion, verdict: "pass", evidence: "looked" })),
    limitations: [],
  })}\n\`\`\``;

test("context files are loaded for every role except the checker roles", async () => {
  const expected: Record<Role, boolean> = {
    planner: true,
    explorer: true,
    implementer: true,
    integrator: true,
    reviewer: false,
    verifier: false,
    falsifier: false,
  };
  for (const [role, loadContextFiles] of Object.entries(expected) as [Role, boolean][]) {
    const checker = !loadContextFiles;
    const h = harness([completeWith(checker ? verdictsJson(["Alpha", "Beta"]) : workJson())], {
      evidence: await candidateEvidence(),
      fingerprints: ["sha256:same"],
    });
    const outcomes = await run(h, checker ? checkerAssignment(role) : assignmentFor(role));
    assert.equal(outcomes[0]?.type, "result", role);
    assert.equal(h.opened[0]?.loadContextFiles, loadContextFiles, role);
  }
});

test("a review that does not judge the producer's criteria is repaired with the exact list", async () => {
  const h = harness(
    [completeWith(verdictsJson(["Alpha", "Invented"])), completeWith(verdictsJson(["Alpha", " Beta "]))],
    {
      evidence: await candidateEvidence(),
      fingerprints: ["sha256:same"],
    },
  );
  const outcomes = await run(h, checkerAssignment("reviewer"));
  assert.equal(outcomes[0]?.type, "result");
  assert.equal(h.session.prompts.length, 2);
  assert.ok((h.session.prompts[1] ?? "").includes('"Alpha", "Beta"'));
  assert.equal(h.evidence.ofKind("review").length, 1);
});

test("a review that still skips a criterion after the repair prompt is schema_invalid", async () => {
  const h = harness([completeWith(verdictsJson(["Alpha"])), completeWith(verdictsJson(["Alpha", "Invented"]))], {
    evidence: await candidateEvidence(),
    fingerprints: ["sha256:same"],
  });
  failedWith(await run(h, checkerAssignment("verifier")), "schema_invalid");
  assert.equal(h.session.prompts.length, 2);
  assert.equal(h.evidence.ofKind("review").length, 0);
  assert.equal(h.session.disposed, 1);
});

test("cancel during a running check aborts it and reports stopped once", async () => {
  let seen: AbortSignal | undefined;
  let started!: () => void;
  const checkStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const h = harness([completeWith(workJson())], {
    runCheck: (profile, input) =>
      new Promise<CheckReceipt>((_resolve, reject) => {
        seen = input.signal;
        input.signal?.addEventListener("abort", () => reject(new Error(`check ${profile.id} aborted`)));
        started();
      }),
  });
  const outcomes: WorkerOutcome[] = [];
  h.worker.start(assignmentFor("implementer", {}, { checks: ["unit"] }), (outcome) => outcomes.push(outcome));
  await checkStarted;
  assert.ok(seen);
  assert.equal(seen.aborted, false);
  h.worker.cancel("attempt-1");
  h.worker.cancel("attempt-1");
  while (outcomes.length === 0) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(outcomes, [{ type: "stopped" }]);
  assert.equal(seen.aborted, true);
  assert.equal(h.evidence.ofKind("proposal").length, 0);
  assert.equal(h.session.disposed, 1);
});
