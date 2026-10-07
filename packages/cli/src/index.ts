#!/usr/bin/env node
import { runDemo } from "./demo.js";
import { runFakeRun } from "./run.js";
import { runTrace } from "./trace.js";
import { runValidate } from "./validate.js";

const USAGE = "Usage: node packages/cli/dist/index.js <demo|trace|run|validate> [options]";

const command = process.argv[2];

if (command === "demo") {
  runDemo();
} else if (command === "trace") {
  runTrace();
} else if (command === "run" || command === "validate") {
  const handler = command === "run" ? runFakeRun : runValidate;
  handler(process.argv.slice(3)).then(
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
