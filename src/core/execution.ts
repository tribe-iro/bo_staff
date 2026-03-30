// Re-export the canonical ExecutionStatus from bomcp/types.ts
export type { ExecutionStatus } from "../bomcp/types.ts";

import type { ExecutionStatus } from "../bomcp/types.ts";

export const EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  "accepted",
  "running",
  "completed",
  "failed",
  "cancelled"
] as const;

export function isTerminalStatus(status: ExecutionStatus): boolean {
  return status === "completed"
    || status === "failed"
    || status === "cancelled";
}
