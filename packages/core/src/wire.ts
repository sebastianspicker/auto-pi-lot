import { z } from "zod";

/** Wire schema version for every persisted or exchanged DTO. Not a graph revision. */
export const SCHEMA_VERSION = 1;

export const SchemaVersionSchema = z.literal(SCHEMA_VERSION);

export const IdSchema = z.string().trim().min(1);
export type Id = z.infer<typeof IdSchema>;

export type IssueCode =
  | "schema_invalid"
  | "unsupported_schema_version"
  | "duplicate_node"
  | "unknown_edge_endpoint"
  | "self_edge"
  | "duplicate_edge"
  | "cycle"
  | "root_has_owner"
  | "child_missing_owner"
  | "delegation_beyond_depth";

export interface ValidationIssue {
  code: IssueCode;
  path: (string | number)[];
  message: string;
}

function hasUnsupportedSchemaVersion(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "schemaVersion" in input &&
    (input as { schemaVersion: unknown }).schemaVersion !== SCHEMA_VERSION
  );
}

/** Strict schema parsing that never throws; typed issues instead of exceptions. */
export function parseDto<T>(
  schema: z.ZodType<T>,
  input: unknown,
): { ok: true; value: T } | { ok: false; issues: ValidationIssue[] } {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };

  const unsupportedVersion = hasUnsupportedSchemaVersion(input);
  const issues: ValidationIssue[] = result.error.issues.map((issue) => {
    const path = issue.path as (string | number)[];
    if (unsupportedVersion && path.length === 1 && path[0] === "schemaVersion") {
      return {
        code: "unsupported_schema_version",
        path,
        message: `Unsupported schema version: ${JSON.stringify((input as { schemaVersion: unknown }).schemaVersion)}`,
      };
    }
    return { code: "schema_invalid", path, message: issue.message };
  });
  return { ok: false, issues };
}
