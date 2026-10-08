#!/usr/bin/env node
import { runArtifact } from "./artifact.js";
import { runDemo } from "./demo.js";
import { runInit } from "./init.js";
import { runInspect } from "./inspect.js";
import { runRun } from "./run.js";
import { runStatus } from "./status.js";
import { runTrace } from "./trace.js";
import { runValidate } from "./validate.js";

const USAGE = "Usage: node packages/cli/dist/index.js <demo|trace|validate|run|init|inspect|status|artifact> [options]";

const command = process.argv[2];
const handlers: Record<string, (args: readonly string[]) => Promise<number>> = {
  validate: runValidate,
  run: runRun,
  init: runInit,
  inspect: runInspect,
  status: runStatus,
  artifact: runArtifact,
};

if (command === "demo") {
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
