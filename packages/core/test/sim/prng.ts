/**
 * Small inline mulberry32 PRNG (no dependency): deterministic across platforms given the
 * same 32-bit seed. Only used by the simulation harness, never by engine source.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Prng {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  /** [0, 1) */
  float(): number {
    return this.next();
  }

  /** [0, maxExclusive) */
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  /** [min, max], inclusive on both ends */
  intBetween(min: number, max: number): number {
    return min + this.int(max - min + 1);
  }

  bool(probabilityTrue = 0.5): boolean {
    return this.next() < probabilityTrue;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error("Prng.pick called with an empty array");
    return item;
  }
}
