import type { ContinuationCapsule } from "../types.ts";

export function parseStoredContinuationCapsule(raw: string): ContinuationCapsule {
  const capsule = JSON.parse(raw) as ContinuationCapsule;
  if (capsule.schema_version !== 1) {
    throw new Error(`Unsupported continuation capsule schema_version: ${String((capsule as { schema_version?: unknown }).schema_version)}`);
  }
  return capsule;
}
