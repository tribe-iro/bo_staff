// Request shape validation from the contract schemas, with bo's error wording: one JSON-Pointer error per field,
// phrased for people ("must be an integer 1–86400", "unknown field"), not for validator authors.

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv/dist/ajv.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import type { FieldError } from "../problems.ts";
import { MessageBody, ResponseBody, RunSpec } from "./schema.ts";

/**
 * The process's one JSON Schema compiler: request schemas below, and callers' output schemas (`spec.ts`), which are
 * compiled per run and evicted right after compilation (compiled validators are self-contained).
 */
export const ajv = new Ajv({ strict: true, allErrors: true, verbose: true, discriminator: true, validateSchema: true, formats: fullFormats });

const REQUESTS = {
  RunSpec: ajv.compile(RunSpec),
  MessageBody: ajv.compile(MessageBody),
  ResponseBody: ajv.compile(ResponseBody),
} satisfies Record<string, ValidateFunction>;

/** Field errors of `value` against a request schema; empty when it has the right shape. */
export function shapeErrors(schema: keyof typeof REQUESTS, value: unknown): FieldError[] {
  const validate = REQUESTS[schema];
  if (validate(value)) return [];
  const seen = new Set<string>();
  const out: FieldError[] = [];
  for (const e of validate.errors ?? []) {
    const error = fieldError(e);
    if (!error || seen.has(error.pointer)) continue;   // one error per field: the first is the most specific
    seen.add(error.pointer);
    out.push(error);
  }
  return out;
}

/** RFC 6901 token escaping. */
export function escapePointer(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

function fieldError(e: ErrorObject): FieldError | undefined {
  const at = e.instancePath;
  const parent = (e.parentSchema ?? {}) as Record<string, unknown>;
  const params = e.params as Record<string, unknown>;
  // A key that breaks `propertyNames` is reported on the key itself.
  if (e.propertyName !== undefined) {
    return e.keyword === "pattern" ? { pointer: `${at}/${escapePointer(e.propertyName)}`, detail: `key must match ${String(params.pattern)}` } : undefined;
  }
  switch (e.keyword) {
    case "additionalProperties":
      return { pointer: `${at}/${escapePointer(String(params.additionalProperty))}`, detail: "unknown field" };
    case "required":
      return { pointer: `${at}/${escapePointer(String(params.missingProperty))}`, detail: "is required" };
    case "type":
    case "minimum":
    case "maximum":
      if (parent.type === "integer" && typeof parent.minimum === "number" && typeof parent.maximum === "number") {
        return { pointer: at, detail: `must be an integer ${parent.minimum}–${parent.maximum}` };
      }
      return { pointer: at, detail: e.keyword === "type" ? `must be ${article(String(params.type))}` : `must be ${e.keyword === "minimum" ? "at least" : "at most"} ${String(params.limit)}` };
    case "minLength":
    case "pattern":
      if (parent.pattern === "\\S") return { pointer: at, detail: "must be a non-empty string" };
      if (parent.pattern === "^/") return { pointer: at, detail: "must be an absolute path" };
      return { pointer: at, detail: `must match ${String(params.pattern)}` };
    case "enum":
      return { pointer: at, detail: `must be one of ${(params.allowedValues as unknown[]).join(", ")}` };
    case "const":
      return { pointer: at, detail: `must be ${JSON.stringify(params.allowedValue)}` };
    case "minItems":
    case "maxItems": {
      const min = typeof parent.minItems === "number" ? parent.minItems : 0;
      return { pointer: at, detail: typeof parent.maxItems === "number" ? `must have ${min}–${parent.maxItems} entries` : `must have at least ${min} entries` };
    }
    case "maxProperties":
      return { pointer: at, detail: `at most ${String(params.limit)} entries` };
    case "format":
      return { pointer: at, detail: params.format === "uri" ? "must be a valid URL" : `must be a valid ${String(params.format)}` };
    case "discriminator": {
      const tag = String(params.tag);
      if (params.error === "tag") return { pointer: `${at}/${tag}`, detail: "is required" };
      const members = (parent.oneOf as { properties?: Record<string, { const?: unknown }> }[] | undefined) ?? [];
      return { pointer: `${at}/${tag}`, detail: `must be one of ${members.map((m) => m.properties?.[tag]?.const).join(", ")}` };
    }
    default:
      // `if`/`oneOf` wrappers: the member's own errors say what is wrong.
      return undefined;
  }
}

function article(type: string): string {
  const first = type.split(",")[0]!;
  return first === "object" || first === "array" || first === "integer" ? `an ${first}` : `a ${first}`;
}
