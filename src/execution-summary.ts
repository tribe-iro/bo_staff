import type { ExecutionSummary } from "./types.ts";

export function buildRejectedExecutionSummary(executionId: string | null, occurredAt: string): ExecutionSummary {
  return {
    execution_id: executionId,
    status: "rejected",
    terminal: true,
    degraded: false,
    retryable: false,
    started_at: occurredAt,
    updated_at: occurredAt,
    completed_at: occurredAt,
    progress_state: "finished"
  };
}
