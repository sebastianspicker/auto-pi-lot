import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { checkMarkdownLinks, findLinkTargets, isCheckableLink, stripAnchor } from "../check-links.js";

test("findLinkTargets extracts every markdown link target", () => {
  const markdown = "See [a](./a.md) and [b](../b.md#section), plus [c](https://example.com).";
  assert.deepEqual(findLinkTargets(markdown), ["./a.md", "../b.md#section", "https://example.com"]);
});

test("isCheckableLink skips URLs and pure anchors, keeps relative paths", () => {
  assert.equal(isCheckableLink("./a.md"), true);
  assert.equal(isCheckableLink("../b.md#section"), true);
  assert.equal(isCheckableLink("#section"), false);
  assert.equal(isCheckableLink("https://example.com"), false);
  assert.equal(isCheckableLink("mailto:a@example.com"), false);
});

test("stripAnchor removes a trailing #anchor", () => {
  assert.equal(stripAnchor("./a.md#section"), "./a.md");
  assert.equal(stripAnchor("./a.md"), "./a.md");
});

test("a broken relative link is reported", () => {
  const markdown = "[missing](./missing.md)";
  const errors = checkMarkdownLinks("docs/plan.md", markdown, () => false);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /missing\.md/);
});

test("a valid relative link with an anchor resolves and is not reported", () => {
  const markdown = "[present](./present.md#section)";
  const errors = checkMarkdownLinks("docs/plan.md", markdown, (path) => path === "docs/present.md");
  assert.deepEqual(errors, []);
});

test("external and pure-anchor links are never checked", () => {
  const markdown = "[site](https://example.com) and [here](#top)";
  const errors = checkMarkdownLinks("docs/plan.md", markdown, () => false);
  assert.deepEqual(errors, []);
});

test("links that leave the repository are skipped, not reported or resolved", () => {
  const markdown = "[sibling](../../../pi-graph/src/a.ts) and [inside](../a.md)";
  const checked: string[] = [];
  const errors = checkMarkdownLinks("docs/reviews/review.md", markdown, (path) => {
    checked.push(path);
    return false;
  });
  assert.deepEqual(checked, [join("docs", "a.md")]);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /\.\.\/a\.md/);
});
