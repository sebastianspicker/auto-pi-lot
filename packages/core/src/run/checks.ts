import { z } from "zod";

import type { ValidatedGraph } from "../graph/validate.js";
import { IdSchema, SchemaVersionSchema, type ValidationIssue } from "../wire.js";
import { RunPolicySchema } from "./events.js";

import { type CheckProfile, CheckProfileSchema, ModelRouteSchema, ThinkingLevelSchema } from "./execution.js";

export * from "./execution.js";

/**
 * The per-repository configuration file (`auto-pi-lot.json` in the workspace root): the check
 * profiles nodes may name, an optional pinned model route and default run limits. Read
 * strictly; unknown keys are errors so a typo cannot silently drop a check.
 */
export const ProjectConfigSchema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    checks: z.array(CheckProfileSchema).max(64),
    /** Additional profiles run only on the combined tree. Node-declared checks are always included. */
    finalChecks: z.array(IdSchema).max(64).optional(),
    model: ModelRouteSchema.optional(),
    thinkingLevel: ThinkingLevelSchema.optional(),
    policy: RunPolicySchema.optional(),
  })
  .superRefine((config, ctx) => {
    const known = new Set(config.checks.map((profile) => profile.id));
    for (const [index, id] of (config.finalChecks ?? []).entries()) {
      if (!known.has(id))
        ctx.addIssue({ code: "custom", path: ["finalChecks", index], message: `Unknown final check profile: ${id}` });
      if (config.finalChecks?.indexOf(id) !== index)
        ctx.addIssue({ code: "custom", path: ["finalChecks", index], message: `Duplicate final check profile: ${id}` });
    }
  });
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/**
 * Cross-checks a validated graph against the check profiles a configuration offers: every
 * `checks` entry of every node must name a configured profile, and profile ids must be unique.
 * Pure; returns every issue found.
 */
export function validateGraphChecks(graph: ValidatedGraph, profiles: readonly CheckProfile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const known = new Set<string>();
  profiles.forEach((profile, index) => {
    if (known.has(profile.id)) {
      issues.push({
        code: "duplicate_check_profile",
        path: ["checks", index, "id"],
        message: `Duplicate check profile: ${profile.id}`,
      });
    }
    known.add(profile.id);
  });
  graph.nodes.forEach((node, nodeIndex) => {
    (node.checks ?? []).forEach((checkId, checkIndex) => {
      if (!known.has(checkId)) {
        issues.push({
          code: "unknown_check_profile",
          path: ["nodes", nodeIndex, "checks", checkIndex],
          message: `Node ${node.id} requires check ${checkId}, which no profile defines`,
        });
      }
    });
  });
  return issues;
}
