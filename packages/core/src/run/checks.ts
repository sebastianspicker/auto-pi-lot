import { z } from "zod";

import { isCheckerRole } from "../graph/spec.js";
import type { ValidatedGraph } from "../graph/validate.js";
import { IdSchema, SchemaVersionSchema, type ValidationIssue } from "../wire.js";
import { RunPolicySchema } from "./events.js";
import { type CheckProfile, CheckProfileSchema, ModelRouteSchema, ThinkingLevelSchema } from "./execution.js";
import { MAX_REPORT_TEXT, MAX_REVIEW_VERDICTS } from "./report.js";

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
    const known = new Set<string>();
    for (const [index, profile] of config.checks.entries()) {
      if (known.has(profile.id))
        ctx.addIssue({
          code: "custom",
          path: ["checks", index, "id"],
          message: `Duplicate check profile: ${profile.id}`,
        });
      known.add(profile.id);
    }
    for (const [index, id] of (config.finalChecks ?? []).entries()) {
      if (!known.has(id))
        ctx.addIssue({ code: "custom", path: ["finalChecks", index], message: `Unknown final check profile: ${id}` });
      if (config.finalChecks?.indexOf(id) !== index)
        ctx.addIssue({ code: "custom", path: ["finalChecks", index], message: `Duplicate final check profile: ${id}` });
    }
  });
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/**
 * A producer that a checker verifies must stay within what one review can cover: at most
 * `MAX_REVIEW_VERDICTS` criteria of at most `MAX_REPORT_TEXT` characters each. Otherwise no
 * review report can ever be valid and every checker attempt ends `schema_invalid`. Checked when
 * a run is admitted and by `validate`, not in the graph schema, so stored journals keep replaying.
 */
export function validateReviewLimits(graph: ValidatedGraph): ValidationIssue[] {
  const checkers = new Set(graph.nodes.filter((node) => isCheckerRole(node.role)).map((node) => node.id));
  const verified = new Set(
    graph.edges.filter((edge) => edge.condition === "result_ready" && checkers.has(edge.to)).map((edge) => edge.from),
  );
  const issues: ValidationIssue[] = [];
  graph.nodes.forEach((node, nodeIndex) => {
    if (!verified.has(node.id)) return;
    if (node.acceptanceCriteria.length > MAX_REVIEW_VERDICTS) {
      issues.push({
        code: "review_limits",
        path: ["nodes", nodeIndex, "acceptanceCriteria"],
        message: `Node ${node.id} has ${node.acceptanceCriteria.length} acceptance criteria; one review can judge at most ${MAX_REVIEW_VERDICTS}`,
      });
    }
    node.acceptanceCriteria.forEach((criterion, index) => {
      if (criterion.length > MAX_REPORT_TEXT) {
        issues.push({
          code: "review_limits",
          path: ["nodes", nodeIndex, "acceptanceCriteria", index],
          message: `Acceptance criterion ${index + 1} of node ${node.id} has ${criterion.length} characters; a review can quote at most ${MAX_REPORT_TEXT}`,
        });
      }
    });
  });
  return issues;
}

/**
 * Cross-checks a validated graph against the check profiles a configuration offers: every
 * `checks` entry of every node must name a configured profile. Unique profile ids are already
 * guaranteed by `ProjectConfigSchema`. Pure; returns every issue found.
 */
export function validateGraphChecks(graph: ValidatedGraph, profiles: readonly CheckProfile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const known = new Set(profiles.map((profile) => profile.id));
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
