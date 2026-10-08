#!/usr/bin/env node
import { ARTIFACT_USAGE, runArtifact } from "./artifact.js";
import { CHECK_USAGE, runChecks } from "./check.js";
import { runDemo } from "./demo.js";
import { INIT_USAGE, runInit } from "./init.js";
import { INSPECT_USAGE, runInspect } from "./inspect.js";
import { RUN_USAGE, runRun } from "./run.js";
import { runStatus, STATUS_USAGE } from "./status.js";
import { runTrace } from "./trace.js";
import { runValidate, VALIDATE_USAGE } from "./validate.js";

const USAGE = "Usage: auto-pi-lot <demo|trace|validate|run|init|check|inspect|status|artifact> [options]";

const command = process.argv[2];
const handlers: Record<string, (args: readonly string[]) => Promise<number>> = {
  validate: runValidate,
  run: runRun,
  init: runInit,
  inspect: runInspect,
  status: runStatus,
  artifact: runArtifact,
  check: runChecks,
};

const usage: Record<string, string> = {
  artifact: ARTIFACT_USAGE,
  check: CHECK_USAGE,
  init: INIT_USAGE,
  inspect: INSPECT_USAGE,
  run: RUN_USAGE,
  status: STATUS_USAGE,
  validate: VALIDATE_USAGE,
};

if (
  command !== undefined &&
  Object.hasOwn(usage, command) &&
  process.argv.length === 4 &&
  ["--help", "-h"].includes(process.argv[3] ?? "")
) {
  console.log(usage[command]);
} else if (command === "--help" || command === "-h" || command === "help") {
  console.log(USAGE);
} else if (command === "demo") {
  runDemo();
} else if (command === "trace") {
  runTrace();
} else if (command !== undefined && Object.hasOwn(handlers, command)) {
  const handler = handlers[command];
  handler?.(process.argv.slice(3)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
} else {
  console.error(USAGE);
  process.exitCode = 1;
}
