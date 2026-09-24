import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);

/** Raw link targets found in `](...)` markdown link syntax. */
export function findLinkTargets(markdown: string): string[] {
  const targets: string[] = [];
  const linkPattern = /]\(([^)]+)\)/g;
  let match: RegExpExecArray | null = linkPattern.exec(markdown);
  while (match !== null) {
    const target = match[1];
    if (target !== undefined) targets.push(target);
    match = linkPattern.exec(markdown);
  }
  return targets;
}

/** Whether a link target is a local path this checker should resolve, not a URL or pure anchor. */
export function isCheckableLink(link: string): boolean {
  if (link.startsWith("#")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(link)) return false;
  return true;
}

/** Whether a repository-relative path escapes the repository root. */
export function isOutsideRepository(resolved: string): boolean {
  return resolved === ".." || resolved.startsWith(`..${sep}`);
}

/** Strips a trailing `#anchor` from a link target. */
export function stripAnchor(link: string): string {
  const hashIndex = link.indexOf("#");
  return hashIndex === -1 ? link : link.slice(0, hashIndex);
}

/**
 * Check every relative markdown link in `markdown` (sourced from `sourceFile`) resolves to
 * an existing file or directory. Links that resolve outside the repository (for example the
 * predecessor review's references into a sibling `pi-graph` checkout) point at another
 * repository, so they are skipped: checking them would make the result depend on what else
 * happens to be checked out next to this one. Pure aside from the injected `fileExists`, so it is testable
 * without touching the real filesystem.
 *
 * @returns human-readable error messages; empty means every checkable link resolved.
 */
export function checkMarkdownLinks(
  sourceFile: string,
  markdown: string,
  fileExists: (path: string) => boolean,
): string[] {
  const errors: string[] = [];
  const dir = dirname(sourceFile);
  for (const rawLink of findLinkTargets(markdown)) {
    if (!isCheckableLink(rawLink)) continue;
    const targetPath = stripAnchor(rawLink);
    if (targetPath.length === 0) continue;
    const resolved = join(dir, targetPath);
    if (isOutsideRepository(resolved)) continue;
    if (!fileExists(resolved)) {
      errors.push(`${sourceFile}: broken link "${rawLink}" (resolved to ${resolved})`);
    }
  }
  return errors;
}

function findMarkdownFiles(root: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(root)) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    const fullPath = join(root, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      results.push(...findMarkdownFiles(fullPath));
    } else if (entry.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

function main(): void {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = findMarkdownFiles(root).sort();
  const errors: string[] = [];
  for (const file of files) {
    const markdown = readFileSync(file, "utf8");
    errors.push(...checkMarkdownLinks(relative(root, file), markdown, (path) => existsSync(join(root, path))));
  }
  if (errors.length > 0) {
    console.error(`Link check failed with ${errors.length} error(s):`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Link check passed (${files.length} markdown file(s)).`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
