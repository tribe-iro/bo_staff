export const EXECUTION_STATUSES = [
  "accepted",
  "running",
  "completed",
  "partial",
  "awaiting_control_gate",
  "failed",
  "rejected"
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export function isTerminalStatus(status: ExecutionStatus): boolean {
  return status === "rejected"
    || status === "failed"
    || status === "completed"
    || status === "partial";
}
