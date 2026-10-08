import { lstat } from "node:fs/promises";

import { type ProjectConfig, ProjectConfigSchema, parseDto } from "@auto-pi-lot/core";

import { readJsonFile } from "./validate.js";

export const EMPTY_CONFIG: ProjectConfig = { schemaVersion: 1, checks: [] };

/**
 * Reads and validates a project configuration file. A missing file is the empty configuration
 * unless `required` (the operator named it with `--config`).
 */
export async function loadConfig(
  file: string,
  required: boolean,
): Promise<{ ok: true; config: ProjectConfig } | { ok: false; error: string }> {
  try {
    await lstat(file);
  } catch (error) {
    if (!required && error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { ok: true, config: EMPTY_CONFIG };
    }
    return { ok: false, error: `Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const read = await readJsonFile(file);
  if (!read.ok) return read;
  const parsed = parseDto(ProjectConfigSchema, read.value);
  if (!parsed.ok) {
    const issues = parsed.issues.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    return { ok: false, error: `${file} is not a valid configuration:\n${issues.join("\n")}` };
  }
  return { ok: true, config: parsed.value };
}
