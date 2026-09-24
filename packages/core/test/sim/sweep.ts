#!/usr/bin/env -S npx tsx
/**
 * Longer, ad hoc seed sweep for the deterministic simulation. `npm run check` only runs a
 * fixed, fast set of seeds (see `sim.test.ts`); this CLI runs many more and reports any
 * failing seed as a regression candidate.
 *
 * Usage: npx tsx packages/core/test/sim/sweep.ts [count] [startSeed]
 */
import { simulate } from "./sim.js";

const count = Number(process.argv[2] ?? 5000);
const startSeed = Number(process.argv[3] ?? 0);

if (!Number.isInteger(count) || count <= 0) {
  console.error(`Invalid count: ${process.argv[2]}`);
  process.exit(1);
}
if (!Number.isInteger(startSeed) || startSeed < 0) {
  console.error(`Invalid startSeed: ${process.argv[3]}`);
  process.exit(1);
}

let failures = 0;
for (let offset = 0; offset < count; offset += 1) {
  const seed = startSeed + offset;
  try {
    simulate(seed);
  } catch (error) {
    failures += 1;
    console.error(`seed ${seed} failed:`);
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  }
}

const ran = count;
console.log(`${ran - failures}/${ran} seeds passed (seeds ${startSeed}..${startSeed + count - 1}).`);
process.exit(failures > 0 ? 1 : 0);
