import { createHash } from "node:crypto";

/**
 * One canonical JSON encoding for hashing and wire identity: sorted object keys,
 * arrays kept in declared order, `-0` normalized to `0`. Throws rather than silently
 * guessing on values with no canonical representation.
 */
function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function canonicalizeValue(value: unknown, path: string): string {
  if (value === null) return "null";
  const type = typeof value;

  if (type === "boolean") return value ? "true" : "false";

  if (type === "number") {
    const num = value as number;
    if (Number.isNaN(num) || !Number.isFinite(num)) {
      throw new TypeError(`Cannot canonicalize non-finite number at ${path}`);
    }
    return JSON.stringify(Object.is(num, -0) ? 0 : num);
  }

  if (type === "string") return JSON.stringify(value);

  if (type === "bigint") throw new TypeError(`Cannot canonicalize bigint at ${path}`);
  if (type === "function") throw new TypeError(`Cannot canonicalize function at ${path}`);
  if (type === "symbol") throw new TypeError(`Cannot canonicalize symbol at ${path}`);
  if (type === "undefined") throw new TypeError(`Cannot canonicalize undefined at ${path}`);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError(`Cannot canonicalize sparse array at ${path}`);
      }
    }
    const items = value.map((item, index) => canonicalizeValue(item, `${path}[${index}]`));
    return `[${items.join(",")}]`;
  }

  if (!isPlainObject(value as object)) {
    throw new TypeError(`Cannot canonicalize non-plain object at ${path}`);
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys.map((key) => {
    const propertyValue = record[key];
    if (propertyValue === undefined) {
      throw new TypeError(`Cannot canonicalize undefined property "${key}" at ${path}`);
    }
    return `${JSON.stringify(key)}:${canonicalizeValue(propertyValue, `${path}.${key}`)}`;
  });
  return `{${parts.join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  return canonicalizeValue(value, "$");
}

/** `"sha256:" + hex(sha256(utf8(canonicalJson(value))))`. */
export function digest(value: unknown): string {
  const hash = createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
  return `sha256:${hash}`;
}
