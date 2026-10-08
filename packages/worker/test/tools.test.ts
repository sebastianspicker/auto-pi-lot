import assert from "node:assert/strict";
import test from "node:test";

import { RoleSchema } from "@auto-pi-lot/core";

import { CHECKER_TOOLS, READER_TOOLS, toolsForRole, WRITER_TOOLS } from "../src/index.js";

test("readers get read-only tools", () => {
  for (const role of ["planner", "explorer", "reviewer"] as const) {
    assert.deepEqual(toolsForRole(role), ["read", "grep", "find", "ls"]);
    assert.equal(toolsForRole(role), READER_TOOLS);
  }
});

test("verifier and falsifier may run commands but not edit", () => {
  for (const role of ["verifier", "falsifier"] as const) {
    assert.deepEqual(toolsForRole(role), ["read", "grep", "find", "ls", "bash"]);
    assert.equal(toolsForRole(role), CHECKER_TOOLS);
  }
});

test("implementer and integrator may edit and write", () => {
  for (const role of ["implementer", "integrator"] as const) {
    assert.deepEqual(toolsForRole(role), ["read", "grep", "find", "ls", "bash", "edit", "write"]);
    assert.equal(toolsForRole(role), WRITER_TOOLS);
  }
});

test("every role has a non-empty tool list", () => {
  for (const role of RoleSchema.options) assert.ok(toolsForRole(role).length > 0);
});
