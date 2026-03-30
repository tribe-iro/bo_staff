import type { ExecutionLease, EphemeralExecutionState } from "../bomcp/types.ts";

export function createEphemeralState(
  executionId: string,
  backend: string,
  lease: ExecutionLease,
): EphemeralExecutionState {
  return {
    execution_id: executionId,
    backend,
    status: "accepted",
    lease,
    artifacts: new Map(),
    processed_request_ids: new Map(),
    started_at: new Date().toISOString(),
  };
}

export function isTerminalStatus(status: EphemeralExecutionState["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
