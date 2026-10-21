import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentSession, AgentSessionEventListener, createAgentSession } from "@earendil-works/pi-coding-agent";

import { createPiSessionOpener, type ModelRuntimeLike } from "../src/opener.js";

type Options = Parameters<typeof createAgentSession>[0];

function fakeModel(provider: string, id: string): ReturnType<ModelRuntimeLike["getModel"]> {
  return { provider, id } as unknown as ReturnType<ModelRuntimeLike["getModel"]>;
}

function runtimeWith(models: { provider: string; id: string }[]): ModelRuntimeLike {
  return {
    getModel: (provider, id) => {
      const found = models.find((model) => model.provider === provider && model.id === id);
      return found === undefined ? undefined : fakeModel(found.provider, found.id);
    },
    getAvailable: async () => models.map((model) => fakeModel(model.provider, model.id)) as never,
  };
}

function fakeFactory(seen: Options[]) {
  return (async (options: Options) => {
    seen.push(options);
    const listeners = new Set<AgentSessionEventListener>();
    const session = {
      getActiveToolNames: () => [...(options?.tools ?? [])],
      prompt: async () => undefined,
      abort: async () => undefined,
      dispose: () => undefined,
      subscribe: (listener: AgentSessionEventListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as AgentSession;
    return { session };
  }) as unknown as typeof createAgentSession;
}

test("the opener pins the requested route and opens a closed session per request", async () => {
  const seen: Options[] = [];
  const opener = await createPiSessionOpener({
    model: { provider: "anthropic", id: "claude-test" },
    thinkingLevel: "low",
    agentDir: "/nonexistent/agent-dir",
    factory: fakeFactory(seen),
    createRuntime: async () => runtimeWith([{ provider: "anthropic", id: "claude-test" }]),
  });
  assert.deepEqual(opener.route, { provider: "anthropic", id: "claude-test" });
  assert.equal(seen.length, 0, "nothing is opened until a request arrives");

  const session = await opener({
    role: "reviewer",
    tools: ["read", "grep"],
    cwd: process.cwd(),
    systemPrompt: "rules",
    loadContextFiles: true,
  });
  assert.equal(seen.length, 1);
  const options = seen[0] as NonNullable<Options>;
  assert.deepEqual(options.tools, ["read", "grep"]);
  assert.equal(options.noTools, "all");
  assert.equal(options.thinkingLevel, "low");
  assert.equal(options.cwd, process.cwd());
  assert.equal((options.model as { id: string } | undefined)?.id, "claude-test");
  assert.ok(options.sessionManager, "an in-memory session manager is supplied");
  assert.ok(options.resourceLoader, "a closed resource loader is supplied");
  session.dispose();
});

test("without a pinned route the first available model is used, and none is an error", async () => {
  const opener = await createPiSessionOpener({
    agentDir: "/nonexistent/agent-dir",
    factory: fakeFactory([]),
    createRuntime: async () => runtimeWith([{ provider: "openai", id: "gpt-test" }]),
  });
  assert.deepEqual(opener.route, { provider: "openai", id: "gpt-test" });

  await assert.rejects(
    createPiSessionOpener({
      agentDir: "/nonexistent/agent-dir",
      factory: fakeFactory([]),
      createRuntime: async () => runtimeWith([]),
    }),
    /No model with credentials is available/,
  );
  await assert.rejects(
    createPiSessionOpener({
      model: { provider: "anthropic", id: "missing" },
      agentDir: "/nonexistent/agent-dir",
      factory: fakeFactory([]),
      createRuntime: async () => runtimeWith([{ provider: "openai", id: "gpt-test" }]),
    }),
    /Model anthropic\/missing is not registered/,
  );
});

test("with a session directory each session's transcript is a file named by its attempt; without one it stays in memory", async () => {
  const sessionDir = path.join(await mkdtemp(path.join(tmpdir(), "apl-opener-sessions-")), "run-x");
  const seen: Options[] = [];
  const settings = {
    model: { provider: "anthropic", id: "claude-test" },
    agentDir: "/nonexistent/agent-dir",
    factory: fakeFactory(seen),
    createRuntime: async () => runtimeWith([{ provider: "anthropic", id: "claude-test" }]),
  };
  const request = { role: "implementer", tools: ["read"], cwd: process.cwd(), systemPrompt: "rules" };
  const persisting = await createPiSessionOpener({ ...settings, sessionDir });
  const attemptId = `sha256:${"ab".repeat(32)}`; // the shape the run reducer gives attempt ids
  (await persisting({ ...request, loadContextFiles: true, attemptId })).dispose();
  const inMemory = await createPiSessionOpener(settings);
  (await inMemory({ ...request, loadContextFiles: true, attemptId: "attempt-8" })).dispose();

  const persisted = seen[0]?.sessionManager;
  assert.equal(persisted?.isPersisted(), true);
  assert.equal(persisted?.getSessionId(), `sha256-${"ab".repeat(32)}`);
  assert.equal(path.dirname(persisted?.getSessionFile() ?? ""), sessionDir);
  assert.match(path.basename(persisted?.getSessionFile() ?? ""), new RegExp(`_sha256-${"ab".repeat(32)}\\.jsonl$`));
  assert.equal(seen[1]?.sessionManager?.isPersisted(), false);
});

test("with shellEnv the bash tool is replaced by one that runs commands under the filtered environment", async () => {
  const seen: Options[] = [];
  const settings = {
    model: { provider: "anthropic", id: "claude-test" },
    agentDir: "/nonexistent/agent-dir",
    factory: fakeFactory(seen),
    createRuntime: async () => runtimeWith([{ provider: "anthropic", id: "claude-test" }]),
  };
  const shellEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ PATH: env.PATH });
  const opener = await createPiSessionOpener({ ...settings, shellEnv });
  const base = { role: "implementer", cwd: process.cwd(), systemPrompt: "rules", loadContextFiles: true };
  (await opener({ ...base, tools: ["read", "bash"] })).dispose();
  (await opener({ ...base, tools: ["read"] })).dispose();
  (await (await createPiSessionOpener(settings))({ ...base, tools: ["read", "bash"] })).dispose();

  const bash = seen[0]?.customTools?.find((tool) => tool.name === "bash");
  assert.ok(bash, "a replacement bash tool is registered when the role may run commands");
  process.env.APL_PLANTED_SECRET = "leaked";
  try {
    const result = await bash.execute(
      "call-1",
      { command: 'printf %s "${APL_PLANTED_SECRET-absent}"' },
      undefined,
      undefined,
      undefined as never,
    );
    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    assert.equal(text.trim(), "absent");
  } finally {
    delete process.env.APL_PLANTED_SECRET;
  }
  assert.deepEqual(seen[1]?.customTools ?? [], [], "no bash tool for a role without bash");
  assert.deepEqual(seen[2]?.customTools ?? [], [], "without shellEnv Pi's own bash is used");
});

test("context files reach the resource loader only when the request allows them", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "apl-opener-"));
  await writeFile(path.join(cwd, "AGENTS.md"), "PLANTED-CONTEXT-MARKER");
  const seen: Options[] = [];
  const opener = await createPiSessionOpener({
    model: { provider: "anthropic", id: "claude-test" },
    agentDir: "/nonexistent/agent-dir",
    factory: fakeFactory(seen),
    createRuntime: async () => runtimeWith([{ provider: "anthropic", id: "claude-test" }]),
  });
  const base = { role: "reviewer", tools: ["read"], cwd, systemPrompt: "rules" };
  (await opener({ ...base, loadContextFiles: true })).dispose();
  (await opener({ ...base, loadContextFiles: false })).dispose();
  const agentFiles = (index: number) =>
    (seen[index]?.resourceLoader?.getAgentsFiles().agentsFiles ?? []).map((f) => f.content);
  assert.ok(agentFiles(0).some((content) => content.includes("PLANTED-CONTEXT-MARKER")));
  assert.deepEqual(agentFiles(1), []);
});
