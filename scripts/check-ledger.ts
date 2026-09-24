import { existsSync, globSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

const AP_ID = /^AP-\d{2}$/;

const EvidenceSchema = z.object({
  kind: z.string(),
  source: z.string().optional(),
  sourceIdentity: z
    .object({
      commit: z.string().nullable().optional(),
      dirtyTreeFingerprint: z.string().nullable().optional(),
    })
    .optional(),
});

const TaskSchema = z.object({
  id: z.string(),
  milestone: z.string(),
  status: z.string(),
  dependsOn: z.array(z.string()),
  acceptanceScenarios: z.array(z.string()),
  evidence: z.array(EvidenceSchema),
  owns: z.array(z.string()),
});

const MilestoneSchema = z.object({
  id: z.string(),
  packages: z.array(z.string()),
});

const ScenarioSchema = z.object({
  id: z.string(),
});

const LedgerSchema = z.object({
  implementationHandoff: z.string(),
  acceptanceMatrix: z.string(),
  baselineHandoff: z.string(),
  legacyReview: z.string(),
  statusVocabulary: z.array(z.string()),
  milestones: z.array(MilestoneSchema),
  tasks: z.array(TaskSchema),
  scenarios: z.array(ScenarioSchema),
});

export type Ledger = z.infer<typeof LedgerSchema>;
export type LedgerTask = z.infer<typeof TaskSchema>;

function hasEvidenceForImplemented(task: z.infer<typeof TaskSchema>): boolean {
  return task.evidence.some((record) => {
    if (record.kind === "historical_report") return true;
    const identity = record.sourceIdentity;
    return Boolean(identity?.commit) || Boolean(identity?.dirtyTreeFingerprint);
  });
}

function findCycle(taskIds: Set<string>, dependsOn: ReadonlyMap<string, string[]>): string | undefined {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  let cycleAt: string | undefined;

  function visit(id: string): void {
    if (cycleAt || visited.has(id)) return;
    if (visiting.has(id)) {
      cycleAt = id;
      return;
    }
    visiting.add(id);
    for (const dep of dependsOn.get(id) ?? []) {
      if (taskIds.has(dep)) visit(dep);
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const id of taskIds) visit(id);
  return cycleAt;
}

/**
 * Validate the implementation ledger against structural and cross-reference
 * invariants. Pure: takes already-parsed JSON and an injected file-existence
 * check so it is testable without touching the real filesystem or ledger.
 *
 * @returns a list of human-readable error messages; empty means the ledger is valid.
 */
export function validateLedger(ledger: unknown, fileExists: (path: string) => boolean): string[] {
  const parsed = LedgerSchema.safeParse(ledger);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => `schema: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  const doc = parsed.data;
  const errors: string[] = [];

  for (const [key, path] of [
    ["implementationHandoff", doc.implementationHandoff],
    ["acceptanceMatrix", doc.acceptanceMatrix],
    ["baselineHandoff", doc.baselineHandoff],
    ["legacyReview", doc.legacyReview],
  ] as const) {
    if (!fileExists(path)) errors.push(`doc path ${key} does not exist on disk: ${path}`);
  }

  const taskIds = new Set<string>();
  for (const task of doc.tasks) {
    if (!AP_ID.test(task.id)) errors.push(`task ID does not match ^AP-\\d{2}$: ${task.id}`);
    if (taskIds.has(task.id)) errors.push(`duplicate task ID: ${task.id}`);
    taskIds.add(task.id);
  }

  const scenarioIds = new Set<string>();
  for (const scenario of doc.scenarios) {
    if (scenarioIds.has(scenario.id)) errors.push(`duplicate scenario ID: ${scenario.id}`);
    scenarioIds.add(scenario.id);
  }

  const milestoneIds = new Set(doc.milestones.map((milestone) => milestone.id));
  for (const milestone of doc.milestones) {
    for (const packageId of milestone.packages) {
      if (!taskIds.has(packageId)) {
        errors.push(`milestone ${milestone.id} references unknown task: ${packageId}`);
      }
    }
  }

  const dependsOn = new Map<string, string[]>();
  for (const task of doc.tasks) {
    dependsOn.set(task.id, task.dependsOn);

    if (!doc.statusVocabulary.includes(task.status)) {
      errors.push(`task ${task.id} has status not in statusVocabulary: ${task.status}`);
    }

    for (const record of task.evidence) {
      if (record.source !== undefined && !fileExists(record.source)) {
        errors.push(`task ${task.id} evidence source does not exist on disk: ${record.source}`);
      }
    }
    for (const dep of task.dependsOn) {
      if (!taskIds.has(dep)) errors.push(`task ${task.id} dependsOn unknown task: ${dep}`);
    }
    for (const scenarioId of task.acceptanceScenarios) {
      if (!scenarioIds.has(scenarioId)) {
        errors.push(`task ${task.id} acceptanceScenarios references unknown scenario: ${scenarioId}`);
      }
    }

    if (!milestoneIds.has(task.milestone)) {
      errors.push(`task ${task.id} references unknown milestone: ${task.milestone}`);
    } else {
      const owningMilestones = doc.milestones.filter((milestone) => milestone.packages.includes(task.id));
      if (owningMilestones.length === 0) {
        errors.push(`task ${task.id} is not listed in any milestone's packages`);
      } else if (owningMilestones.length > 1) {
        errors.push(
          `task ${task.id} is listed in more than one milestone: ${owningMilestones.map((m) => m.id).join(", ")}`,
        );
      } else if (owningMilestones[0]?.id !== task.milestone) {
        errors.push(
          `task ${task.id} declares milestone ${task.milestone} but is listed under ${owningMilestones[0]?.id}`,
        );
      }
    }

    if (task.status === "implemented" && !hasEvidenceForImplemented(task)) {
      errors.push(
        `task ${task.id} has status implemented but no evidence record with a commit, ` +
          "dirtyTreeFingerprint, or kind historical_report",
      );
    }

    if (task.status !== "not_started") {
      for (const ownedPath of task.owns) {
        if (!fileExists(ownedPath)) {
          errors.push(`task ${task.id} owns path that does not exist on disk: ${ownedPath}`);
        }
      }
    }
  }

  const cycleAt = findCycle(taskIds, dependsOn);
  if (cycleAt) errors.push(`dependsOn graph has a cycle reachable from: ${cycleAt}`);

  return errors;
}

/** A literal path must exist; an `owns` glob such as `packages/*` must match at least one path. */
export function pathExists(path: string, cwd: string): boolean {
  return path.includes("*") ? globSync(path, { cwd }).length > 0 : existsSync(`${cwd}/${path}`);
}

function main(): void {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const raw = JSON.parse(readFileSync(`${root}/docs/implementation-ledger.json`, "utf8"));
  const errors = validateLedger(raw, (path) => pathExists(path, root));
  if (errors.length > 0) {
    console.error(`Ledger validation failed with ${errors.length} error(s):`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log("Ledger validation passed.");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
