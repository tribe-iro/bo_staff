import { stableJson } from "./utils.ts";

export function reportInternalError(scope: string, error: unknown, context?: Record<string, unknown>): void {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  const serializedContext = context ? ` context=${safeSerialize(context)}` : "";
  process.stderr.write(`[bo_staff] ${scope}: ${message}${serializedContext}\n`);
}

function safeSerialize(value: Record<string, unknown>): string {
  try {
    return stableJson(value);
  } catch {
    return "[unserializable-context]";
  }
}
