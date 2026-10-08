import assert from "node:assert/strict";
import test from "node:test";
import type { SourceFileSystem } from "../source-fingerprint.js";
import { computeSourceFingerprint } from "../source-fingerprint.js";

type FakeEntry = string | { symlink: string };

function fakeFs(entries: Record<string, FakeEntry>): SourceFileSystem {
  return {
    lstat: (path) => {
      const entry = entries[path];
      if (entry === undefined) return "missing";
      return typeof entry === "string" ? "file" : "symlink";
    },
    readFile: (path) => Buffer.from(entries[path] as string, "utf8"),
    readlink: (path) => (entries[path] as { symlink: string }).symlink,
  };
}

test("computeSourceFingerprint is deterministic across input order", () => {
  const fs = fakeFs({ "a.ts": "A", "b.ts": "B" });
  const forward = computeSourceFingerprint(["a.ts", "b.ts"], fs);
  const reversed = computeSourceFingerprint(["b.ts", "a.ts"], fs);
  assert.equal(forward, reversed);
});

test("a content change changes the fingerprint", () => {
  const before = computeSourceFingerprint(["a.ts"], fakeFs({ "a.ts": "A" }));
  const after = computeSourceFingerprint(["a.ts"], fakeFs({ "a.ts": "B" }));
  assert.notEqual(before, after);
});

test("a deleted tracked path is fingerprinted as a deletion marker instead of throwing", () => {
  const fs = fakeFs({});
  assert.doesNotThrow(() => computeSourceFingerprint(["deleted.ts"], fs));
  const deletedFingerprint = computeSourceFingerprint(["deleted.ts"], fs);
  const presentFingerprint = computeSourceFingerprint(["deleted.ts"], fakeFs({ "deleted.ts": "" }));
  assert.notEqual(deletedFingerprint, presentFingerprint);
});

test("a symlink is hashed by its target string, not the target's content", () => {
  const sameTarget = fakeFs({ "link.ts": { symlink: "./real.ts" } });
  const differentTarget = fakeFs({ "link.ts": { symlink: "./other.ts" } });
  assert.notEqual(
    computeSourceFingerprint(["link.ts"], sameTarget),
    computeSourceFingerprint(["link.ts"], differentTarget),
  );

  const readingSymlinkContentThrows: SourceFileSystem = {
    lstat: () => "symlink",
    readFile: () => {
      throw new Error("must not read a symlink's target content");
    },
    readlink: () => "./real.ts",
  };
  assert.doesNotThrow(() => computeSourceFingerprint(["link.ts"], readingSymlinkContentThrows));
});

test("an empty file list produces a stable fingerprint", () => {
  const fs = fakeFs({});
  const first = computeSourceFingerprint([], fs);
  const second = computeSourceFingerprint([], fs);
  assert.equal(first, second);
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
});
