import test from "node:test";

import { simulate } from "./sim.js";

const SEED_COUNT = 200;

test(`${SEED_COUNT} seeded simulations reach a terminal state without violating an invariant`, () => {
  for (let seed = 0; seed < SEED_COUNT; seed += 1) {
    simulate(seed);
  }
});
