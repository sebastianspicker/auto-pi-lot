import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { criteriaMissing, extractJsonBlock } from "../src/run/report.js";

test("criteriaMissing matches verdicts to criteria by exact text after trimming", () => {
  const review = { verdicts: [{ criterion: " rejects empty email " }, { criterion: "Logs the error" }] };
  assert.deepEqual(criteriaMissing(["rejects empty email", "logs the error", "  keeps the form  "], review), [
    "logs the error",
    "keeps the form",
  ]);
  assert.deepEqual(criteriaMissing(["rejects empty email"], review), []);
});

test("extracts the last complete JSON fence with whitespace and invalid-final semantics", () => {
  assert.deepEqual(extractJsonBlock('intro ```json \r\n {"ok":true}\n \t``` tail'), { ok: true });
  assert.deepEqual(extractJsonBlock('```json\n{}\n```\n```json\n{"last":1}\n```'), { last: 1 });
  assert.equal(extractJsonBlock("```json\n\n```"), null);
  assert.equal(extractJsonBlock('```json\n{"ok":true}\n```\n```json\ninvalid\n```'), null);
  assert.deepEqual(extractJsonBlock("```json\n[1,2]\n```\n```json\nunterminated"), [1, 2]);
  assert.equal(extractJsonBlock("```json no newline\n{}"), null);
});

test("unterminated whitespace reports and repeated inline markers finish without backtracking", () => {
  const moduleUrl = new URL("../src/run/report.ts", import.meta.url).href;
  const script = [
    `import assert from "node:assert/strict";`,
    `import { extractJsonBlock } from ${JSON.stringify(moduleUrl)};`,
    `const marker = ${JSON.stringify("```json\n")};`,
    `assert.equal(extractJsonBlock(marker + "\\n ".repeat(500_000) + "x"), null);`,
    `assert.equal(extractJsonBlock(marker + "x\`\`\`json\\n".repeat(100_000) + "x"), null);`,
    `assert.equal(extractJsonBlock(marker + "x\`\`\`".repeat(100_000) + "x"), null);`,
  ].join("\n");
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { timeout: 10_000 });
});
