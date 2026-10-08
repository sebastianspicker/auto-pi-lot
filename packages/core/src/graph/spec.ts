import { z } from "zod";

import { IdSchema, SchemaVersionSchema } from "../wire.js";

const positiveInteger = z.number().int().positive();

export const RoleSchema = z.enum([
  "planner",
  "explorer",
  "implementer",
  "verifier",
  "falsifier",
  "reviewer",
  "integrator",
]);
export type Role = z.infer<typeof RoleSchema>;

/** Roles whose attempts may change the workspace; they compete for the run's writer slots. */
export const WRITER_ROLES: readonly Role[] = ["implementer", "integrator"];

export function isWriterRole(role: Role): boolean {
  return WRITER_ROLES.includes(role);
}

/** Roles whose result is itself a review receipt about a consumed producer's result. */
export const CHECKER_ROLES: readonly Role[] = ["verifier", "falsifier", "reviewer"];

export function isCheckerRole(role: Role): boolean {
  return CHECKER_ROLES.includes(role);
}

export const DEFAULT_ATTEMPT_TIMEOUT_MS = 1_800_000;
export const MAX_ATTEMPT_TIMEOUT_MS = 86_400_000;

export const NodeLimitsSchema = z.strictObject({
  maxTokens: positiveInteger,
  maxToolCalls: positiveInteger,
  /** Wall-clock allowance including session setup, report repair and checks. Default: 30 minutes. */
  timeoutMs: positiveInteger.max(MAX_ATTEMPT_TIMEOUT_MS).optional(),
  maxChildGraphs: z.number().int().nonnegative().optional(),
});
export type NodeLimits = z.infer<typeof NodeLimitsSchema>;

export const NodeSpecSchema = z.strictObject({
  id: IdSchema,
  role: RoleSchema,
  objective: z.string().trim().min(1),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
  inputArtifactIds: z.array(IdSchema).optional(),
  /**
   * Check profile ids (see `CheckProfileSchema`) the host runs against the workspace after each
   * attempt of this node; every one must pass before the result can be accepted. Omitted or
   * empty: no deterministic check, so acceptance rests on verifying nodes alone.
   */
  checks: z.array(IdSchema).max(32).optional(),
  /** Extra guidance handed to the worker verbatim, as data: it cannot widen the node's permissions. */
  instructions: z.string().trim().min(1).max(20_000).optional(),
  limits: NodeLimitsSchema,
});
export type NodeSpec = z.infer<typeof NodeSpecSchema>;

/** A verifier may consume provisional output; a trusting consumer requires acceptance. */
export const DependencyConditionSchema = z.enum(["result_ready", "accepted"]);
export type DependencyCondition = z.infer<typeof DependencyConditionSchema>;

/** A dependency edge always declares whether the consumer trusts or merely observes. */
export const EdgeSpecSchema = z.strictObject({
  from: IdSchema,
  to: IdSchema,
  condition: DependencyConditionSchema,
});
export type EdgeSpec = z.infer<typeof EdgeSpecSchema>;

export const GraphSpecSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  id: IdSchema,
  runId: IdSchema,
  ownerNodeId: IdSchema.optional(),
  depth: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  revision: positiveInteger,
  nodes: z.array(NodeSpecSchema).min(1),
  edges: z.array(EdgeSpecSchema),
});
export type GraphSpec = z.infer<typeof GraphSpecSchema>;
