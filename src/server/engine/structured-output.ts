import { z } from "zod";

type Shape = {
  [key: string]: unknown;
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, Shape>;
  required?: string[];
  items?: Shape;
  anyOf?: Shape[];
  oneOf?: Shape[];
};

/** Transport-only optional → required/nullable conversion. Saved contracts stay
 * unchanged; explicit null is removed only where the original field was optional
 * and did not itself allow null. Runtime validation remains authoritative.
 * https://developers.openai.com/api/docs/guides/structured-outputs */
export function structuredOutput<T>(contract: z.ZodType<T>) {
  const original = z.toJSONSchema(contract) as Shape;
  const resolve = (shape: Shape): Shape => {
    if (!shape.$ref) return shape;
    if (!shape.$ref.startsWith("#/")) throw new Error("Unsupported schema reference");
    let target: unknown = original;
    for (const key of shape.$ref.slice(2).split("/"))
      target = (target as Record<string, unknown>)[key.replaceAll("~1", "/").replaceAll("~0", "~")];
    if (!target || typeof target !== "object") throw new Error("Unresolved schema reference");
    return target as Shape;
  };
  const nullable = (raw: Shape): boolean => {
    const s = resolve(raw);
    return s.type === "null" || (Array.isArray(s.type) && s.type.includes("null")) ||
      !!s.anyOf?.some(nullable) || !!s.oneOf?.some(nullable);
  };
  const convert = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(convert);
    if (!value || typeof value !== "object") return value;
    const s = value as Shape;
    const result = Object.fromEntries(Object.entries(s).filter(([key]) => key !== "default").map(([key, v]) => [key, convert(v)])) as Shape;
    if (s.properties) {
      result.properties = Object.fromEntries(Object.entries(s.properties).map(([key, child]) => {
        const converted = convert(child) as Shape;
        return [key, !s.required?.includes(key) && !nullable(child)
          ? { anyOf: [converted, { type: "null" }] } : converted];
      }));
      result.required = Object.keys(s.properties);
      result.additionalProperties = false;
    }
    return result;
  };
  const normalize = (value: unknown, raw: Shape): unknown => {
    const s = resolve(raw);
    // Apply union branches only when their concrete type matches. Object-union
    // constraints still pass through the original Zod validator below.
    const branches = s.anyOf ?? s.oneOf;
    if (branches) {
      const branch = branches.find((b) => {
        const t = resolve(b).type;
        return t === (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
      });
      if (branch) return normalize(value, branch);
    }
    if (Array.isArray(value) && s.items) return value.map((v) => normalize(v, s.items!));
    if (value && typeof value === "object" && !Array.isArray(value) && s.properties) {
      return Object.fromEntries(Object.entries(value).flatMap(([key, v]) => {
        const child = s.properties![key];
        if (!child) return [[key, v]];
        if (v === null && !s.required?.includes(key) && !nullable(child)) return [];
        return [[key, normalize(v, child)]];
      }));
    }
    return value;
  };
  return {
    schema: convert(original),
    parse: (value: unknown): T => contract.parse(normalize(value, original)),
  };
}
