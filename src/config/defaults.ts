import type { JsonSchema } from "../types.ts";
import type { PerformanceTier } from "../engine/types.ts";

export const DEFAULT_ATTACHMENT_CHAR_LIMIT = 8_000;
export const DEFAULT_MAX_CONCURRENT_EXECUTIONS = 8;
export const DEFAULT_SESSIONLESS_EXECUTION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export const DEFAULT_MESSAGE_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["content"],
  additionalProperties: false,
  properties: {
    content: { type: "string" }
  }
};

export const DEFAULT_EXECUTION_TIMEOUT_MS_BY_TIER: Record<PerformanceTier, number> = {
  fast: 60_000,
  balanced: 120_000,
  high: 300_000,
  frontier: 600_000
};

export function resolveDefaultExecutionTimeoutMs(performanceTier: PerformanceTier): number {
  return DEFAULT_EXECUTION_TIMEOUT_MS_BY_TIER[performanceTier];
}
