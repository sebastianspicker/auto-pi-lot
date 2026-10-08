import { join, resolve } from "node:path";

/** Where the CLI keeps runtime state and reads its configuration, relative to one workspace. */
export interface RuntimePaths {
  readonly journal: string;
  readonly evidence: string;
  readonly artifacts: string;
  readonly config: string;
}

/** The runtime directory inside a workspace; gitignored. */
export const RUNTIME_DIR = ".auto-pi-lot";
export const CONFIG_FILE = "auto-pi-lot.json";
export const PLAN_FILE = "auto-pi-lot.plan.json";

/** The one place the `.auto-pi-lot` layout is spelled out. A journal override is resolved against the cwd. */
export function runtimePaths(workspace: string, journalOverride?: string): RuntimePaths {
  const root = resolve(workspace);
  const runtime = join(root, RUNTIME_DIR);
  return {
    journal: journalOverride === undefined ? join(runtime, "journal") : resolve(journalOverride),
    evidence: join(runtime, "evidence"),
    artifacts: join(runtime, "artifacts"),
    config: join(root, CONFIG_FILE),
  };
}
