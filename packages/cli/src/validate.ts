import { readFile, stat } from "node:fs/promises";

import {
  getReadyNodes,
  lintGraph,
  topologicalOrder,
  type ValidatedGraph,
  type ValidationIssue,
  validateGraph,
  validateReviewLimits,
} from "@auto-pi-lot/core";

import { parseFlags } from "./args.js";

export const VALIDATE_USAGE = "Usage: auto-pi-lot validate <graph.json> [--strict]";

export interface ValidateOptions {
  readonly file: string;
  readonly strict: boolean;
}

/** Parses `validate`'s arguments; never throws, so the entry point can print the usage line. */
export function parseValidateArgs(
  args: readonly string[],
): { ok: true; options: ValidateOptions } | { ok: false; error: string } {
  const parsed = parseFlags(args, { values: [], switches: ["--strict"], positionals: 1 });
  if (!parsed.ok) return parsed;
  const [file = ""] = parsed.flags.positionals;
  return { ok: true, options: { file, strict: parsed.flags.switches.has("--strict") } };
}

/** Largest graph file `validate` and `run --graph` read; a graph is small data, not an artifact. */
export const MAX_GRAPH_FILE_BYTES = 1_048_576;

/**
 * Reads a JSON file into `unknown`; the caller validates it with the core schemas. Only a regular
 * file up to `MAX_GRAPH_FILE_BYTES` is read, and a parse failure is reported without echoing the
 * file's content (Node's own message quotes a snippet of it).
 */
export async function readJsonFile(file: string): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  let text: string;
  try {
    const info = await stat(file);
    if (!info.isFile()) return { ok: false, error: `Cannot read ${file}: not a regular file` };
    if (info.size > MAX_GRAPH_FILE_BYTES) {
      return { ok: false, error: `Cannot read ${file}: larger than ${MAX_GRAPH_FILE_BYTES} bytes` };
    }
    text = await readFile(file, "utf8");
  } catch (error) {
    return { ok: false, error: `Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: `${file} is not valid JSON` };
  }
}

/** Prints the issues of an invalid graph file as the `validate` report. */
export function printInvalidGraph(file: string, issues: readonly ValidationIssue[]): void {
  const report = {
    mode: "validate",
    file,
    ok: false,
    issues: issues.map((issue) => ({ code: issue.code, path: issue.path, message: issue.message })),
  };
  console.log(JSON.stringify(report, null, 2));
}

/** Checks a graph file and prints issues, warnings, order and ready nodes. Returns the exit code. */
export async function runValidate(args: readonly string[]): Promise<number> {
  const parsed = parseValidateArgs(args);
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error(VALIDATE_USAGE);
    return 2;
  }
  const { file, strict } = parsed.options;
  const read = await readJsonFile(file);
  if (!read.ok) {
    console.error(read.error);
    console.error(VALIDATE_USAGE);
    return 2;
  }
  const result = validateGraph(read.value);
  if (!result.ok) {
    printInvalidGraph(file, result.issues);
    return 1;
  }
  const graph: ValidatedGraph = result.graph;
  const limitIssues = validateReviewLimits(graph);
  if (limitIssues.length > 0) {
    printInvalidGraph(file, limitIssues);
    return 1;
  }
  const warnings = lintGraph(graph).map((warning) => ({
    code: warning.code,
    path: warning.path,
    message: warning.message,
  }));
  const report = {
    mode: "validate",
    file,
    ok: true,
    graph: {
      id: graph.id,
      runId: graph.runId,
      depth: graph.depth,
      revision: graph.revision,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
    },
    topologicalOrder: topologicalOrder(graph),
    readyNodeIds: getReadyNodes(graph, new Map()).map((node) => node.id),
    warnings,
  };
  console.log(JSON.stringify(report, null, 2));
  return strict && warnings.length > 0 ? 1 : 0;
}
