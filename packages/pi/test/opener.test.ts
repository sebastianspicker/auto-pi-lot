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
