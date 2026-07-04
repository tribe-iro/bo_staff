import type { JsonSchema } from "../types.ts";

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export const DEFAULT_ATTACHMENT_CHAR_LIMIT = 8_000;
export const DEFAULT_MAX_CONCURRENT_EXECUTIONS = 8;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
export const DEFAULT_EXECUTION_TIMEOUT_MS = 120_000;

// Inline attachment content is bounded at the validation boundary — not just by the HTTP
// body cap — so the limit also covers the in-process gateway.execute() path. Env-overridable.
export const MAX_ATTACHMENT_CONTENT_BYTES = positiveIntFromEnv("BO_STAFF_MAX_ATTACHMENT_CONTENT_BYTES", 1_048_576); // 1 MiB per attachment
export const MAX_TOTAL_INLINE_BYTES = positiveIntFromEnv("BO_STAFF_MAX_TOTAL_INLINE_BYTES", 4_194_304); // 4 MiB aggregate

export const DEFAULT_MESSAGE_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["content"],
  additionalProperties: false,
  properties: {
    content: { type: "string" }
  }
};
