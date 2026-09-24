import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { type Ledger, type LedgerTask, pathExists, validateLedger } from "../check-ledger.js";

const alwaysExists = () => true;

const defaultTask: LedgerTask = {
  id: "AP-00",
  milestone: "M0",
  status: "not_started",
  dependsOn: [],
  acceptanceScenarios: ["AT-01"],
  evidence: [],
  owns: [],
};

function ledgerWithTasks(tasks: LedgerTask[], milestonePackages: string[] = tasks.map((task) => task.id)): Ledger {
  return {
    implementationHandoff: "docs/design.md",
    acceptanceMatrix: "docs/acceptance-matrix.md",
    baselineHandoff: "docs/archive/scaffold-handoff.md",
    legacyReview: "docs/reviews/legacy.md",
    statusVocabulary: ["not_started", "implemented"],
    milestones: [{ id: "M0", packages: milestonePackages }],
    tasks,
    scenarios: [{ id: "AT-01" }],
  };
}

function minimalLedger(): Ledger {
  return ledgerWithTasks([defaultTask]);
}

test("a valid minimal ledger passes with no errors", () => {
  assert.deepEqual(validateLedger(minimalLedger(), alwaysExists), []);
});

test("a cycle in dependsOn is reported", () => {
  const taskA: LedgerTask = { ...defaultTask, id: "AP-00", dependsOn: ["AP-01"], acceptanceScenarios: [] };
  const taskB: LedgerTask = { ...defaultTask, id: "AP-01", dependsOn: ["AP-00"], acceptanceScenarios: [] };
  const errors = validateLedger(ledgerWithTasks([taskA, taskB]), alwaysExists);
  assert.ok(
    errors.some((error) => error.includes("cycle")),
    JSON.stringify(errors),
  );
});

test("a dangling dependsOn reference is reported", () => {
  const task: LedgerTask = { ...defaultTask, dependsOn: ["AP-99"] };
  const errors = validateLedger(ledgerWithTasks([task]), alwaysExists);
  assert.ok(
    errors.some((error) => error.includes("dependsOn unknown task: AP-99")),
    JSON.stringify(errors),
  );
});

test("a dangling acceptance scenario reference is reported", () => {
  const task: LedgerTask = { ...defaultTask, acceptanceScenarios: ["AT-99"] };
  const errors = validateLedger(ledgerWithTasks([task]), alwaysExists);
  assert.ok(
    errors.some((error) => error.includes("references unknown scenario: AT-99")),
    JSON.stringify(errors),
  );
});

test("a duplicate task ID is reported", () => {
  const errors = validateLedger(ledgerWithTasks([defaultTask, defaultTask], ["AP-00"]), alwaysExists);
  assert.ok(
    errors.some((error) => error.includes("duplicate task ID: AP-00")),
    JSON.stringify(errors),
  );
});

test("an implemented task without qualifying evidence is reported", () => {
  const task: LedgerTask = { ...defaultTask, status: "implemented", evidence: [] };
  const errors = validateLedger(ledgerWithTasks([task]), alwaysExists);
  assert.ok(
    errors.some((error) => error.includes("no evidence record")),
    JSON.stringify(errors),
  );
});

test("an implemented task with a historical_report is accepted without a commit", () => {
  const task: LedgerTask = { ...defaultTask, status: "implemented", evidence: [{ kind: "historical_report" }] };
  assert.deepEqual(validateLedger(ledgerWithTasks([task]), alwaysExists), []);
});

test("an implemented task with a commit-bearing evidence record is accepted", () => {
  const task: LedgerTask = {
    ...defaultTask,
    status: "implemented",
    evidence: [{ kind: "unit", sourceIdentity: { commit: "abc123", dirtyTreeFingerprint: null } }],
  };
  assert.deepEqual(validateLedger(ledgerWithTasks([task]), alwaysExists), []);
});

test("an in_progress task with a missing owned path is reported", () => {
  const task: LedgerTask = { ...defaultTask, status: "in_progress", owns: ["packages/missing/src/index.ts"] };
  const ledger: Ledger = {
    ...ledgerWithTasks([task]),
    statusVocabulary: ["not_started", "in_progress", "implemented"],
  };
  const errors = validateLedger(ledger, () => false);
  assert.ok(
    errors.some((error) => error.includes("owns path that does not exist on disk: packages/missing/src/index.ts")),
    JSON.stringify(errors),
  );
});

test("a not_started task with a missing owned path is not reported", () => {
  const task: LedgerTask = { ...defaultTask, status: "not_started", owns: ["packages/missing/src/index.ts"] };
  const errors = validateLedger(ledgerWithTasks([task]), () => false);
  assert.ok(!errors.some((error) => error.includes("owns path that does not exist on disk")), JSON.stringify(errors));
});

test("an evidence record citing a missing source file is reported", () => {
  const task: LedgerTask = { ...defaultTask, evidence: [{ kind: "historical_report", source: "docs/plans/moved.md" }] };
  const errors = validateLedger(ledgerWithTasks([task]), (path) => path !== "docs/plans/moved.md");
  assert.ok(errors.some((error) => error.includes("evidence source does not exist on disk: docs/plans/moved.md")));
});

test("a missing doc path is reported", () => {
  const errors = validateLedger(minimalLedger(), () => false);
  assert.ok(
    errors.some((error) => error.includes("implementationHandoff")),
    JSON.stringify(errors),
  );
});

test("pathExists accepts literal paths and globs that match at least one path", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  assert.equal(pathExists("package.json", root), true);
  assert.equal(pathExists("packages/*", root), true);
  assert.equal(pathExists("packages/*/no-such-file.ts", root), false);
  assert.equal(pathExists("no-such-file.json", root), false);
});
