import type { ExecutionLease } from "../core/lease.ts";
import type { EphemeralExecutionState } from "./types.ts";

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
