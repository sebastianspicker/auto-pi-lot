export interface FlagSpec {
  /** Flags that take one value. */
  readonly values: readonly string[];
  /** Flags without a value. */
  readonly switches: readonly string[];
  /** How many positional arguments are accepted (and required). Default 0. */
  readonly positionals?: number;
}

export interface ParsedFlags {
  readonly values: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
  readonly positionals: readonly string[];
}

/** Parses `args` against `spec`; never throws. Each flag may be given once. */
export function parseFlags(
  args: readonly string[],
  spec: FlagSpec,
): { ok: true; flags: ParsedFlags } | { ok: false; error: string } {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const positionals: string[] = [];
  const wanted = spec.positionals ?? 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) break;
    if (spec.switches.includes(arg)) {
      if (switches.has(arg)) return { ok: false, error: `${arg} given twice` };
      switches.add(arg);
    } else if (spec.values.includes(arg)) {
      const value = args[index + 1];
      // A missing, empty or flag-like value is an incomplete argument.
      if (value === undefined || value === "" || value.startsWith("--")) {
        return { ok: false, error: `Unknown or incomplete argument: ${arg}` };
      }
      if (values.has(arg)) return { ok: false, error: `${arg} given twice` };
      values.set(arg, value);
      index += 1;
    } else if (arg.startsWith("--") || arg === "" || positionals.length >= wanted) {
      return { ok: false, error: `Unknown or incomplete argument: ${arg}` };
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length < wanted) return { ok: false, error: "Missing argument" };
  return { ok: true, flags: { values, switches, positionals } };
}

export function positiveInteger(value: string): number | null {
  const number = /^[1-9][0-9]*$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(number) ? number : null;
}
