import type { CodingSession } from "@auto-pi-lot/core/session";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { openPiSession, type PiSessionFactory } from "./session.js";

/** What a worker asks for when it opens a session for one attempt. Structurally the worker's `SessionOpenRequest`. */
export interface PiSessionRequest {
  readonly role: string;
  /** Pi built-in tool names the attempt may use; nothing else is registered. */
  readonly tools: readonly string[];
  readonly cwd: string;
  /** Replaces Pi's default system prompt entirely. */
  readonly systemPrompt: string;
  /** Whether the repository's context files (AGENTS.md and the like) are loaded; false for checkers. */
  readonly loadContextFiles: boolean;
}

export type PiThinkingLevel = "off" | "low" | "medium" | "high";

export interface PiOpenerOptions {
  /** Exact route: provider and model id as Pi's registry names them. Default: the first model with credentials. */
  readonly model?: { readonly provider: string; readonly id: string };
  readonly thinkingLevel?: PiThinkingLevel;
  /** Pi's global config directory (credentials, models.json). Default: Pi's own (`~/.pi/agent`). */
  readonly agentDir?: string;
  /** The SDK factory; injectable so tests never create a real session. Default: `createAgentSession`. */
  readonly factory?: PiSessionFactory;
  /** Builds the model runtime; injectable for tests. Default: `ModelRuntime.create()` on `agentDir`. */
  readonly createRuntime?: (agentDir: string) => Promise<ModelRuntimeLike>;
}

/** The two members of `ModelRuntime` the opener uses. */
export interface ModelRuntimeLike {
  getModel: ModelRuntime["getModel"];
  getAvailable: ModelRuntime["getAvailable"];
}

export interface PiSessionOpener {
  (request: PiSessionRequest): Promise<CodingSession>;
  /** The route every session opened by this opener uses. */
  readonly route: { readonly provider: string; readonly id: string };
}

async function defaultRuntime(agentDir: string): Promise<ModelRuntimeLike> {
  return ModelRuntime.create({ authPath: `${agentDir}/auth.json`, modelsPath: `${agentDir}/models.json` });
}

/**
 * Resolves the model route once, up front, and returns a function that opens one closed Pi
 * session per request: in-memory transcript, no extensions, skills or prompt templates, the
 * request's tool allowlist only, the request's system prompt instead of Pi's, SDK retries off
 * (an unaccounted retry is a hidden model call), and the repository's own context files
 * (AGENTS.md and the like) applied, as data, only when the request allows it. Credentials stay in Pi's store; the session
 * never sees them as text. Nothing is called until the returned opener is used.
 */
export async function createPiSessionOpener(options: PiOpenerOptions = {}): Promise<PiSessionOpener> {
  const agentDir = options.agentDir ?? getAgentDir();
  const runtime = await (options.createRuntime ?? defaultRuntime)(agentDir);
  const factory = options.factory ?? createAgentSession;

  let model: ReturnType<ModelRuntimeLike["getModel"]>;
  if (options.model !== undefined) {
    model = runtime.getModel(options.model.provider, options.model.id);
    if (model === undefined) {
      throw new Error(`Model ${options.model.provider}/${options.model.id} is not registered in ${agentDir}`);
    }
  } else {
    model = (await runtime.getAvailable())[0];
    if (model === undefined) {
      throw new Error(`No model with credentials is available in ${agentDir}; run pi once to log in, or pass --model`);
    }
  }
  const resolved = model;
  const route = { provider: resolved.provider, id: resolved.id };

  const opener = async (request: PiSessionRequest): Promise<CodingSession> => {
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: request.cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: !request.loadContextFiles,
      systemPromptOverride: () => request.systemPrompt,
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();
    return openPiSession(factory, {
      cwd: request.cwd,
      agentDir,
      modelRuntime: runtime as ModelRuntime,
      model: resolved,
      ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
      tools: [...request.tools],
      noTools: "all",
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(request.cwd),
    });
  };
  return Object.assign(opener, { route });
}
