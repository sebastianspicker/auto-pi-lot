import { appendFile, lstat, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  type CheckProfile,
  CheckProfileSchema,
  type GraphSpec,
  type ProjectConfig,
  ProjectConfigSchema,
  parseDto,
  validateGraph,
} from "@auto-pi-lot/core";

import { parseFlags } from "./args.js";
import { CONFIG_FILE, PLAN_FILE, RUNTIME_DIR } from "./paths.js";
import { checkWorkspace } from "./run.js";
import { readJsonFile } from "./validate.js";

export const INIT_USAGE = "Usage: auto-pi-lot init [--workspace <dir>] [--force]";

export interface InitOptions {
  readonly workspace: string | null;
  readonly force: boolean;
}

export function parseInitArgs(
  args: readonly string[],
): { ok: true; options: InitOptions } | { ok: false; error: string } {
  const parsed = parseFlags(args, { values: ["--workspace"], switches: ["--force"] });
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    options: { workspace: parsed.flags.values.get("--workspace") ?? null, force: parsed.flags.switches.has("--force") },
  };
}

/** The scripts worth offering as checks, in the order a plan should list them. */
const SCRIPT_NAMES = ["test", "lint", "typecheck", "check", "build"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One `npm run <script>` profile per well-known script in the workspace's package.json. Data only: never run. */
async function discoverChecks(workspace: string): Promise<CheckProfile[]> {
  const read = await readJsonFile(join(workspace, "package.json"));
  if (!read.ok || !isRecord(read.value) || !isRecord(read.value.scripts)) return [];
  const scripts = read.value.scripts;
  const profiles: CheckProfile[] = [];
  for (const name of SCRIPT_NAMES) {
    if (typeof scripts[name] !== "string") continue;
    const profile = parseDto(CheckProfileSchema, {
      id: name,
      description: `npm run ${name}`,
      command: "npm",
      args: ["run", name],
      timeoutMs: 600_000,
    });
    if (profile.ok) profiles.push(profile.value);
  }
  return profiles;
}

function stamp(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace(/[-:]/g, "")
    .replace("T", "-");
}

async function kindOf(path: string): Promise<"missing" | "file" | "other"> {
  try {
    return (await lstat(path)).isFile() ? "file" : "other";
  } catch {
    return "missing";
  }
}

/** Keeps the runtime directory out of the repository; appends to an existing `.gitignore` or creates one. */
async function ignoreRuntimeDir(workspace: string): Promise<boolean> {
  const path = join(workspace, ".gitignore");
  const line = `${RUNTIME_DIR}/`;
  let current = "";
  try {
    if (!(await lstat(path)).isFile()) return false;
    current = await readFile(path, "utf8");
  } catch {
    current = "";
  }
  const present = current.split(/\r?\n/).some((entry) => entry.trim() === line || entry.trim() === RUNTIME_DIR);
  if (present) return false;
  const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  await appendFile(path, `${prefix}# auto-pi-lot runtime state (journal, evidence, artifacts)\n${line}\n`, "utf8");
  return true;
}

/** Writes `auto-pi-lot.json` and `auto-pi-lot.plan.json` into the workspace. Returns the exit code. */
export async function runInit(args: readonly string[]): Promise<number> {
  const parsed = parseInitArgs(args);
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error(INIT_USAGE);
    return 1;
  }
  const workspace = resolve(parsed.options.workspace ?? process.cwd());
  const workspaceProblem = await checkWorkspace(workspace);
  if (workspaceProblem !== null) {
    console.error(workspaceProblem);
    return 1;
  }
  const configPath = join(workspace, CONFIG_FILE);
  const planPath = join(workspace, PLAN_FILE);
  for (const path of [configPath, planPath]) {
    const kind = await kindOf(path);
    if (kind === "missing") continue;
    if (!parsed.options.force) {
      console.error(`${path} already exists; pass --force to overwrite it`);
      return 1;
    }
    // `--force` replaces a regular file; it never writes through a link to somewhere else.
    if (kind !== "file") {
      console.error(`${path} is not a regular file; refusing to overwrite it`);
      return 1;
    }
  }

  const checks = await discoverChecks(workspace);
  const checkIds = checks.map((check) => check.id);
  const name = basename(workspace) || "workspace";
  const config: ProjectConfig = {
    schemaVersion: 1,
    checks,
    policy: { maxConcurrent: 1, maxAttemptsPerNode: 2, maxConcurrentWriters: 1 },
  };
  const plan: GraphSpec = {
    schemaVersion: 1,
    id: `${name}-plan`,
    runId: `${name}-${stamp(new Date())}`,
    depth: 0,
    revision: 1,
    nodes: [
      {
        id: "implement",
        role: "implementer",
        objective: "Describe the change you want here",
        acceptanceCriteria: ["State what must be true when the work is done"],
        ...(checkIds.length === 0 ? {} : { checks: checkIds }),
        limits: { maxTokens: 200_000, maxToolCalls: 150, timeoutMs: 1_800_000 },
      },
      {
        id: "review",
        role: "reviewer",
        objective: "Review the implementation against its acceptance criteria",
        acceptanceCriteria: ["Every criterion of implement is judged with evidence"],
        limits: { maxTokens: 100_000, maxToolCalls: 60, timeoutMs: 900_000 },
      },
    ],
    edges: [{ from: "implement", to: "review", condition: "result_ready" }],
  };
  // The generated files must satisfy the same schemas `run` reads them with.
  if (!parseDto(ProjectConfigSchema, config).ok || !validateGraph(plan).ok) {
    console.error("Internal error: the generated configuration or plan is invalid");
    return 1;
  }

  const flag = parsed.options.force ? "w" : "wx";
  try {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag });
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, { flag });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  let gitignored = false;
  try {
    gitignored = await ignoreRuntimeDir(workspace);
  } catch (error) {
    console.error(`Could not update .gitignore: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(
    JSON.stringify({ mode: "init", config: configPath, plan: planPath, checks: checkIds, gitignored }, null, 2),
  );
  console.error("Edit auto-pi-lot.plan.json, then: auto-pi-lot run --worker pi --graph auto-pi-lot.plan.json");
  return 0;
}
