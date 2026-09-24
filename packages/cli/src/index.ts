import { runDemo } from "./demo.js";
import { runTrace } from "./trace.js";

const USAGE = "Usage: node packages/cli/dist/index.js <demo|trace>";

const command = process.argv[2];

if (command === "demo") {
  runDemo();
} else if (command === "trace") {
  runTrace();
} else {
  console.error(USAGE);
  process.exitCode = 1;
}
