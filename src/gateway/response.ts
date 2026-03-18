import { partitionControlGates } from "../engine/control-gate-manager.ts";
import { buildPersistenceSummary, progressStateForStatus } from "../engine/execution-state.ts";
import { buildRejectedExecutionSummary } from "../execution-summary.ts";
import { buildValidationRejectionCapabilityState } from "../engine/event-projection.ts";
import { buildUnavailableOutcome } from "../compat/degradation.ts";
import { CAPABILITY_NAMES } from "../core/index.ts";
import { RequestResolutionError } from "../errors.ts";
import type {
  CapabilityName,
  ExecutionResponse,
  NormalizedExecutionRequest,
  SessionListResponse,
  SessionRecordSummary
} from "../types.ts";
import type { SessionPageCursor, SessionRecord, StoredExecutionSnapshot } from "../persistence/types.ts";

export function buildValidationRejectionResponse(input: {
  requestId: string;
  occurredAt: string;
  message: string;
  durabilityKind?: ExecutionResponse["session"]["durability_kind"];
}): ExecutionResponse {
  const rejectionState = buildValidationRejectionCapabilityState();
  return {
    api_version: "v0.1",
    request_id: input.requestId,
    execution: buildRejectedExecutionSummary(null, input.occurredAt),
    persistence: buildPersistenceSummary("not_attempted"),
    execution_profile: {
      requested_performance_tier: "balanced",
      requested_reasoning_tier: "standard",
      selection_mode: "managed",
      resolved_backend_model: "unresolved",
      resolution_source: "managed"
    },
    session: {
      handle: null,
      continuity_kind: "none",
      durability_kind: input.durabilityKind ?? "persistent"
    },
    workspace: {
      topology: "direct",
      scope_status: "unbounded",
      writeback_status: "not_requested",
      materialization_status: "not_requested"
    },
    capabilities: rejectionState.capabilities,
    result: {
      summary: "Request validation failed.",
      payload: {},
      pending_items: []
    },
    artifacts: [],
    control_gates: {
      pending: [],
      resolved: []
    },
    errors: [{
      code: "validation_error",
      message: input.message
    }],
    debug: {
      capability_diagnostics: rejectionState.diagnostics
    }
  };
}

export function snapshotToExecutionResponse(snapshot: StoredExecutionSnapshot): ExecutionResponse {
  if (snapshot.execution.response_snapshot) {
    return normalizeStoredExecutionResponse(snapshot.execution.response_snapshot);
  }

  const controlGates = partitionControlGates(snapshot.control_gates);
  const executionStatus = snapshot.execution.status;
  return {
    api_version: "v0.1",
    request_id: snapshot.execution.request_id,
    execution: {
      execution_id: snapshot.execution.execution_id,
      status: executionStatus,
      terminal: Boolean(snapshot.execution.completed_at),
      degraded: snapshot.execution.degraded,
      retryable: snapshot.execution.retryable,
      started_at: snapshot.execution.started_at,
      updated_at: snapshot.execution.updated_at,
      completed_at: snapshot.execution.completed_at,
      progress_state: progressStateForStatus(executionStatus)
    },
    persistence: buildPersistenceSummary("persisted"),
    execution_profile: snapshot.execution.execution_profile,
    session: resolveExecutionSessionSummary(snapshot),
    workspace: snapshot.workspace.summary,
    capabilities: completeCapabilityOutcomes(snapshot.capability_outcomes),
    result: {
      summary: executionStatus === "running"
        ? "Execution in progress."
        : executionStatus === "awaiting_control_gate"
          ? "Execution is awaiting control-gate resolution."
          : "Execution has no stored terminal response snapshot.",
      payload: {},
      pending_items: []
    },
    artifacts: snapshot.artifacts,
    control_gates: controlGates,
    usage: snapshot.execution.usage,
    errors: [],
    debug: undefined
  };
}

export function toSessionListResponse(input: {
  sessions: SessionRecord[];
  next_after?: SessionPageCursor;
}): SessionListResponse {
  return {
    sessions: input.sessions.map(toSessionRecordSummary),
    next_cursor: input.next_after ? encodeSessionCursor(input.next_after) : undefined
  };
}

export function toSessionRecordSummary(session: SessionRecord): SessionRecordSummary {
  return {
    handle: session.handle,
    backend: session.backend,
    continuity_kind: session.continuity_kind,
    durability_kind: session.durability_kind,
    continued_from: session.continued_from,
    forked_from: session.forked_from,
    created_at: session.created_at,
    updated_at: session.updated_at,
    latest_execution_id: session.latest_execution_id,
    latest_status: session.latest_status
  };
}

export function clampSessionPageLimit(value: number | undefined): number {
  if (value === undefined) {
    return 100;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new RequestResolutionError("limit must be a positive integer when provided", "invalid_limit");
  }
  return Math.min(value, 500);
}

export function decodeSessionCursor(cursor: string | undefined): SessionPageCursor | undefined {
  if (!cursor) {
    return undefined;
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<SessionPageCursor>;
    if (typeof decoded.created_at === "string" && typeof decoded.handle === "string") {
      return {
        created_at: decoded.created_at,
        handle: decoded.handle
      };
    }
  } catch {
    // handled below
  }
  throw new RequestResolutionError("cursor must be a valid bo_staff session page cursor", "invalid_cursor");
}

function encodeSessionCursor(cursor: SessionPageCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function resolveExecutionSessionSummary(snapshot: StoredExecutionSnapshot): ExecutionResponse["session"] {
  if (snapshot.session) {
    return {
      handle: snapshot.session.handle,
      continued_from: snapshot.session.continued_from,
      forked_from: snapshot.session.forked_from,
      continuity_kind: snapshot.session.continuity_kind,
      durability_kind: snapshot.session.durability_kind
    };
  }
  const request = snapshot.execution.request_snapshot as Partial<NormalizedExecutionRequest>;
  return {
    handle: null,
    continuity_kind: "none",
    durability_kind: request.session?.mode === "ephemeral" ? "ephemeral" : "persistent"
  };
}

function completeCapabilityOutcomes(
  value: Partial<Record<CapabilityName, ExecutionResponse["capabilities"][CapabilityName]>>
): ExecutionResponse["capabilities"] {
  const outcomes = {} as Record<CapabilityName, ExecutionResponse["capabilities"][CapabilityName]>;
  for (const capability of CAPABILITY_NAMES) {
    outcomes[capability] = value[capability] ?? buildUnavailableOutcome("Capability outcome unavailable.");
  }
  return outcomes;
}

function normalizeStoredExecutionResponse(response: ExecutionResponse): ExecutionResponse {
  return {
    ...response,
    execution: {
      ...response.execution,
      progress_state: response.execution.progress_state ?? progressStateForStatus(response.execution.status)
    },
    persistence: response.persistence ?? buildPersistenceSummary("persisted")
  };
}
