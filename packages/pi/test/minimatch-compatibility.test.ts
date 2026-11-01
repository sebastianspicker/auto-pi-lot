import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

// Resolve from the pinned SDK, rather than accidentally testing a root-only dependency.
const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const sdkRequire = createRequire(sdkEntry);
const { Minimatch, minimatch } = sdkRequire("minimatch") as {
  Minimatch: new (
    pattern: string,
    options: { dot?: boolean; optimizationLevel?: number; braceExpandMax?: number },
  ) => { set: unknown[]; match: (path: string, partial?: boolean) => boolean };
  minimatch: (path: string, pattern: string, options?: { nocase?: boolean }) => boolean;
};

test("the SDK-resolved matcher bounds optimization expansion without breaking ordinary patterns", () => {
  const pattern = `${Array(8).fill("**/../x").join("/")}/file.js`;
  const matcher = new Minimatch(pattern, { dot: true, optimizationLevel: 2, braceExpandMax: 8 });
  assert.ok(matcher.set.length <= 8, "generated alternatives must respect the configured expansion cap");
  assert.equal(minimatch("nested/file.js", "**/*.js"), true);
  assert.equal(minimatch("nested/file.txt", "**/*.js"), false);
  assert.equal(minimatch("skills/review/SKILL.md", "skills/*/SKILL.md"), true);
  assert.equal(minimatch("skills/review", "skills/*"), true);
  assert.equal(minimatch("file.js", "!**/*.tmp"), true);
  assert.equal(new Minimatch("**/*.js", { dot: true }).match("nested/", true), true);
});

test("the actual SDK model scope preserves provider, case, thinking-level and no-match behavior", async () => {
  type Model = { provider: string; id: string };
  const { resolveModelScopeFromModels } = (await import(new URL("./core/model-resolver.js", sdkEntry).href)) as {
    resolveModelScopeFromModels: (
      patterns: string[],
      models: Model[],
    ) => { scopedModels: { model: Model; thinkingLevel?: string }[]; diagnostics: { code: string }[] };
  };
  const alpha = { provider: "provider-a", id: "Alpha-1" };
  const beta = { provider: "provider-b", id: "Beta-2" };
  const result = resolveModelScopeFromModels(["PROVIDER-A/alpha-*:high", "*beta*", "missing-*"], [alpha, beta]);
  assert.deepEqual(result.scopedModels, [
    { model: alpha, thinkingLevel: "high" },
    { model: beta, thinkingLevel: undefined },
  ]);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["no-match"],
  );
});
