import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { checkMarkdownLinks, findLinkTargets, isCheckableLink, stripAnchor } from "../check-links.js";

test("findLinkTargets extracts every markdown link target", () => {
  const markdown = "See [a](./a.md) and [b](../b.md#section), plus [c](https://example.com).";
  assert.deepEqual(findLinkTargets(markdown), ["./a.md", "../b.md#section", "https://example.com"]);
});

test("findLinkTargets drops link titles and unwraps angle-bracket targets", () => {
  assert.deepEqual(findLinkTargets("[a](README.md \"title\") [b](README.md 'title')"), ["README.md", "README.md"]);
  assert.deepEqual(findLinkTargets('[c](<docs/a b.md>) [d](<docs/a b.md> "t")'), ["docs/a b.md", "docs/a b.md"]);
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

test("links with titles and angle-bracket targets resolve to their path", () => {
  const markdown = `[a](a.md "title") [b](b.md 'title') [c](<dir/c d.md>) [e](<e.md#part> "t")`;
  const checked: string[] = [];
  const errors = checkMarkdownLinks("docs/plan.md", markdown, (path) => {
    checked.push(path);
    return true;
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(checked, [
    join("docs", "a.md"),
    join("docs", "b.md"),
    join("docs", "dir", "c d.md"),
    join("docs", "e.md"),
  ]);
});

test("a broken link with a title is reported by its path", () => {
  const errors = checkMarkdownLinks("docs/plan.md", '[x](missing.md "title")', () => false);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /broken link "missing\.md"/);
});

test("findLinkTargets ignores link syntax in fenced code blocks and inline code spans", () => {
  const markdown = [
    "[a](a.md) and `[b](b.md)` then [c](c.md)",
    "```md",
    "[d](d.md)",
    "```",
    "~~~",
    "[e](e.md)",
    "~~~",
    "[f](f.md)",
  ].join("\n");
  assert.deepEqual(findLinkTargets(markdown), ["a.md", "c.md", "f.md"]);
});

test("percent-escapes in a link path are decoded before resolving", () => {
  const checked: string[] = [];
  const errors = checkMarkdownLinks("docs/plan.md", "[a](a%20b.md#x)", (path) => {
    checked.push(path);
    return true;
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(checked, [join("docs", "a b.md")]);
});

test("a malformed percent-escape falls back to the raw path", () => {
  const checked: string[] = [];
  checkMarkdownLinks("docs/plan.md", "[a](100%.md)", (path) => {
    checked.push(path);
    return true;
  });
  assert.deepEqual(checked, [join("docs", "100%.md")]);
});

test("a root-absolute link resolves against the repository root", () => {
  const checked: string[] = [];
  const errors = checkMarkdownLinks("docs/reviews/review.md", "[r](/README.md) [d](/docs/a.md)", (path) => {
    checked.push(path);
    return true;
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(checked, ["README.md", join("docs", "a.md")]);
});
