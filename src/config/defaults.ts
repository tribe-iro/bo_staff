import type { JsonSchema } from "../types.ts";

export const DEFAULT_ATTACHMENT_CHAR_LIMIT = 8_000;
export const DEFAULT_MAX_CONCURRENT_EXECUTIONS = 8;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
export const DEFAULT_EXECUTION_TIMEOUT_MS = 120_000;

export const DEFAULT_MESSAGE_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["content"],
  additionalProperties: false,
  properties: {
    content: { type: "string" }
  }
};

export function resolveDefaultExecutionTimeoutMs(): number {
  return DEFAULT_EXECUTION_TIMEOUT_MS;
}
