import type { Role } from "@auto-pi-lot/core";

/** Pi built-in tool names. Readers can look but not run or change anything. */
export const READER_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];
/** Checkers may also run commands (`bash`), but have no file-editing tool. */
export const CHECKER_TOOLS: readonly string[] = ["read", "grep", "find", "ls", "bash"];
/** Writers may run commands and change files in the workspace. */
export const WRITER_TOOLS: readonly string[] = ["read", "grep", "find", "ls", "bash", "edit", "write"];

/** The tool allowlist a session of this role is opened with. */
export function toolsForRole(role: Role): readonly string[] {
  switch (role) {
    case "planner":
    case "explorer":
    case "reviewer":
      return READER_TOOLS;
    case "verifier":
    case "falsifier":
      return CHECKER_TOOLS;
    case "implementer":
    case "integrator":
      return WRITER_TOOLS;
  }
}
