export type ExecutionStatus =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

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
