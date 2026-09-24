import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalJson, digest } from "../src/index.js";

interface CanonicalVector {
  name: string;
  input: unknown;
  canonical: string;
  digest: string;
}

const vectorsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "vectors", "canonical.json");
const vectors = JSON.parse(readFileSync(vectorsPath, "utf8")) as CanonicalVector[];

test("committed canonical JSON vectors match canonicalJson and digest", () => {
  assert.ok(vectors.length >= 8, "expected at least 8 committed vectors");
  for (const vector of vectors) {
    assert.equal(canonicalJson(vector.input), vector.canonical, vector.name);
    assert.equal(digest(vector.input), vector.digest, vector.name);
  }
});

test("canonicalJson rejects values with no canonical representation", () => {
  assert.throws(() => canonicalJson(undefined));
  assert.throws(() => canonicalJson(Number.NaN));
  assert.throws(() => canonicalJson(Number.POSITIVE_INFINITY));
  assert.throws(() => canonicalJson(Number.NEGATIVE_INFINITY));
  assert.throws(() => canonicalJson(10n));
  assert.throws(() => canonicalJson(() => {}));
  assert.throws(() => canonicalJson(Symbol("s")));
  assert.throws(() => canonicalJson({ a: undefined }));

  const sparse: unknown[] = [1];
  sparse[3] = 2;
  assert.throws(() => canonicalJson(sparse));

  assert.throws(() => canonicalJson(new Date()));
  assert.throws(() => canonicalJson(new Map()));

  class Foo {
    x = 1;
  }
  assert.throws(() => canonicalJson(new Foo()));
});
