import { z } from "zod";

import type { ValidatedGraph } from "../graph/validate.js";
import { IdSchema, SchemaVersionSchema, type ValidationIssue } from "../wire.js";
import { RunPolicySchema } from "./events.js";

const positiveInteger = z.number().int().positive();

/** Longest a single check may run before the runner kills its process group. */
export const MAX_CHECK_TIMEOUT_MS = 3_600_000;
export const DEFAULT_CHECK_TIMEOUT_MS = 600_000;

/**
 * A deterministic check the host runs itself, never through a model: one executable and an
 * argument list (no shell), in the workspace or a directory inside it, under a timeout. A node
 * names the profiles it must pass in `NodeSpec.checks`. The profile is data an operator wrote;
 * the worker cannot add or alter one.
 */
export const CheckProfileSchema = z.strictObject({
  id: IdSchema,
  /** Human-readable purpose, shown in reports. */
  description: z.string().trim().min(1).max(500).optional(),
  command: z.string().trim().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(256),
  /** Working directory relative to the workspace root; must stay inside it. Default: the root. */
  cwd: z.string().trim().min(1).max(1024).optional(),
  timeoutMs: positiveInteger.max(MAX_CHECK_TIMEOUT_MS).optional(),
});
export type CheckProfile = z.infer<typeof CheckProfileSchema>;

/** A pinned model route for the real worker: provider and model id as the SDK's registry names them. */
export const ModelRouteSchema = z.strictObject({
  provider: z.string().trim().min(1).max(128),
  id: z.string().trim().min(1).max(256),
});
export type ModelRoute = z.infer<typeof ModelRouteSchema>;

export const ThinkingLevelSchema = z.enum(["off", "low", "medium", "high"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

/**
 * The per-repository configuration file (`auto-pi-lot.json` in the workspace root): the check
 * profiles nodes may name, an optional pinned model route and default run limits. Read
 * strictly; unknown keys are errors so a typo cannot silently drop a check.
 */
export const ProjectConfigSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  checks: z.array(CheckProfileSchema).max(64),
  model: ModelRouteSchema.optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
  policy: RunPolicySchema.optional(),
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
