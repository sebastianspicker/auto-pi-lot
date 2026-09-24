import { z } from "zod";

import { IdSchema, SchemaVersionSchema } from "../wire.js";

const positiveInteger = z.number().int().positive();

export const RoleSchema = z.enum(["planner", "explorer", "implementer", "verifier", "reviewer", "integrator"]);
export type Role = z.infer<typeof RoleSchema>;

export const NodeLimitsSchema = z.strictObject({
  maxTokens: positiveInteger,
  maxToolCalls: positiveInteger,
  maxChildGraphs: z.number().int().nonnegative().optional(),
});
export type NodeLimits = z.infer<typeof NodeLimitsSchema>;

export const NodeSpecSchema = z.strictObject({
  id: IdSchema,
  role: RoleSchema,
  objective: z.string().trim().min(1),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
  inputArtifactIds: z.array(IdSchema).optional(),
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
