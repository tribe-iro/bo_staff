import type { ArtifactRecord } from "../core/artifact.ts";
import type { ExecutionStatus } from "../core/execution.ts";
import type { ExecutionLease } from "../core/lease.ts";
import type { ExecutionProgressProjection } from "../types/api.ts";

export interface EphemeralExecutionState {
  execution_id: string;
  backend: string;
  agent_id?: string;
  status: ExecutionStatus;
  lease: ExecutionLease;
  artifacts: Map<string, ArtifactRecord>;
  processed_request_ids: Map<string, unknown>;
  started_at: string;
  progress?: ExecutionProgressProjection;
}
