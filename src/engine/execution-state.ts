import { resolveExecutionProfile } from "../config/execution-profiles.ts";
import { RequestResolutionError, UpstreamRuntimeError } from "../errors.ts";
import type {
  ArtifactRecord,
  BackendName,
  CapabilityDiagnostic,
  CapabilityName,
  ContinuationCapsule,
  ContinuationCapsuleMemorySlot,
  ExecutionError,
  ExecutionDebug,
  ExecutionPersistenceSummary,
  ExecutionResponse,
  ExecutionStatus,
  ExecutionSummary,
  NormalizedExecutionRequest,
  SessionSummary
} from "../types.ts";
import type { ControlGateRecord } from "../types.ts";
import type { SessionResolution } from "./session-manager.ts";
import type { WorkspaceRuntime } from "./workspace-manager.ts";
import { stableJson } from "../utils.ts";

export interface ProviderAccumulation {
  artifactMap: Map<string, ArtifactRecord>;
  controlGateMap: Map<string, ControlGateRecord>;
  providerSessionId?: string;
  providerUsage?: ExecutionResponse["usage"];
  providerDebug?: Record<string, unknown>;
  rawOutputText: string;
  providerFailed?: ExecutionError;
}

export function uniqueArtifacts(value: ArtifactRecord, index: number, values: ArtifactRecord[]): boolean {
  for (let currentIndex = 0; currentIndex < index; currentIndex += 1) {
    if (values[currentIndex]?.artifact_id === value.artifact_id) {
      return false;
    }
  }
  return true;
}

export function createProviderAccumulation(session: SessionResolution): ProviderAccumulation {
  return {
    artifactMap: new Map(),
    controlGateMap: new Map(),
    providerSessionId: session.provider_session_id,
    rawOutputText: ""
  };
}

export function buildRejectedWorkspaceSummary(request: NormalizedExecutionRequest): ExecutionResponse["workspace"] {
  if (request.workspace.kind === "ephemeral") {
    return {
      topology: "direct",
      scope_status: "unbounded",
      writeback_status: "not_requested",
      materialization_status: "not_requested"
    };
  }
  const managedWritebackSkipped = request.workspace.topology === "git_isolated" && request.workspace.writeback === "apply";
  return {
    topology: request.workspace.topology,
    scope_status: request.workspace.scope.mode === "subpath" ? "enforced" : "unbounded",
    writeback_status: managedWritebackSkipped
      ? "skipped"
      : request.workspace.writeback === "apply"
        ? "not_requested"
        : "discarded",
    materialization_status: managedWritebackSkipped ? "skipped" : "not_requested"
  };
}

export function buildWorkspaceSummary(workspace: WorkspaceRuntime): ExecutionResponse["workspace"] {
  return {
    topology: workspace.topology,
    scope_status: workspace.scope_status,
    writeback_status: workspace.writeback_status,
    materialization_status: workspace.materialization_status,
    diagnostics: workspace.diagnostics
  };
}

export function buildSessionSummary(session: SessionResolution): SessionSummary {
  return {
    handle: session.public_handle,
    continued_from: session.continued_from,
    forked_from: session.forked_from,
    continuity_kind: session.continuity_kind,
    durability_kind: session.durability_kind
  };
}

export function buildWorkspaceRecord(
  executionId: string,
  session: SessionResolution,
  workspace: WorkspaceRuntime,
  summary = buildWorkspaceSummary(workspace)
) {
  return {
    execution_id: executionId,
    session_handle: session.record ? session.internal_handle : null,
    summary,
    retained_workspace_handle: workspace.topology === "git_isolated" ? workspace.retained_workspace_handle : undefined,
    repo_root: workspace.topology === "git_isolated" ? workspace.repo_root : undefined,
    worktree_dir: workspace.topology === "git_isolated" ? workspace.worktree_dir : undefined
  };
}

export function isExecutionDegraded(
  outcomes: Record<string, { status: string }>,
  workspace: WorkspaceRuntime
): boolean {
  return Object.values(outcomes).some((outcome) => outcome.status === "degraded")
    || workspace.writeback_status === "degraded"
    || workspace.materialization_status === "failed";
}

export function mergeExecutionDebug(
  debug: Record<string, unknown> | undefined,
  diagnostics: Record<CapabilityName, CapabilityDiagnostic>
): ExecutionDebug {
  return {
    ...(debug ?? {}),
    capability_diagnostics: diagnostics
  };
}

export function buildPersistenceSummary(
  status: ExecutionPersistenceSummary["status"],
  reason?: string
): ExecutionPersistenceSummary {
  return {
    status,
    reason
  };
}

export function progressStateForStatus(status: ExecutionStatus): ExecutionSummary["progress_state"] {
  switch (status) {
    case "running":
      return "running";
    case "awaiting_control_gate":
      return "waiting_for_control_gate";
    default:
      return "finished";
  }
}

export function formatExecutionError(error: unknown): ExecutionError {
  if (error instanceof RequestResolutionError) {
    return {
      code: error.code,
      message: error.message
    };
  }
  if (error instanceof UpstreamRuntimeError) {
    return {
      code: error.kind === "rate_limit" ? "rate_limit" : "upstream_runtime_error",
      message: error.message,
      retryable: error.kind === "rate_limit"
    };
  }
  return {
    code: "runtime_error",
    message: error instanceof Error ? error.message : String(error)
  };
}

export function buildFinalSessionRecord(input: {
  session: SessionResolution;
  request: NormalizedExecutionRequest;
  backend: BackendName;
  executionId: string;
  providerSessionId?: string;
  response: ExecutionResponse;
}) {
  if (!input.session.record) {
    return undefined;
  }
  if (input.request.session.mode === "continue" && input.response.execution.status === "failed") {
    // Preserve the original session identity/workspace metadata when a continue attempt fails.
    // Otherwise a failed cross-workspace/backend continuation would mutate future resume semantics.
    return {
      ...input.session.record,
      latest_execution_id: input.executionId,
      latest_status: input.response.execution.status,
      updated_at: input.response.execution.updated_at
    };
  }
  return {
    ...input.session.record,
    backend: input.backend,
    provider_session_id: input.providerSessionId ?? input.session.provider_session_id,
    latest_execution_id: input.executionId,
    latest_status: input.response.execution.status,
    continuation_capsule: input.response.execution.status === "completed" || input.response.execution.status === "partial"
      ? buildContinuationCapsule({
        priorExecutionId: input.executionId,
        backendOrigin: input.backend,
        summary: input.response.result.summary,
        payload: input.response.result.payload,
        artifacts: input.response.artifacts
      })
      : input.session.record.continuation_capsule,
    workspace_topology: input.request.workspace.topology,
    source_root: input.request.workspace.source_root,
    workspace_scope_mode: input.request.workspace.scope.mode,
    workspace_scope_subpath: input.request.workspace.scope.mode === "subpath"
      ? input.request.workspace.scope.subpath
      : undefined,
    updated_at: input.response.execution.updated_at
  };
}

export async function resolveExecutionProfileSafe(
  request: NormalizedExecutionRequest,
  profilesFile?: string
): Promise<import("../types.ts").ResolvedExecutionProfile> {
  try {
    return await resolveExecutionProfile({ request, profilesFile });
  } catch {
    return {
      requested_performance_tier: request.execution_profile.performance_tier,
      requested_reasoning_tier: request.execution_profile.reasoning_tier,
      selection_mode: request.execution_profile.selection_mode,
      resolved_backend_model: request.execution_profile.override ?? "unresolved",
      resolved_backend_reasoning_control: undefined,
      resolution_source: request.execution_profile.selection_mode
    };
  }
}

export function pruneBeforeIso(retentionMs: number): string {
  return new Date(Date.now() - retentionMs).toISOString();
}

function buildContinuationCapsule(input: {
  priorExecutionId: string;
  backendOrigin: BackendName;
  summary: string;
  payload: unknown;
  artifacts: ArtifactRecord[];
}): ContinuationCapsule {
  const slots: ContinuationCapsuleMemorySlot[] = [];
  if (input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)) {
    const rememberedToken = (input.payload as Record<string, unknown>).remembered_token;
    if (typeof rememberedToken === "string" && rememberedToken.length > 0) {
      slots.push({
        key: "remembered_token",
        value: rememberedToken.slice(0, 256)
      });
    }
  }
  if (input.artifacts.length > 0) {
    slots.push({
      key: "artifact_refs",
      value: input.artifacts.slice(0, 32).map((artifact) => artifact.artifact_id)
    });
  }
  return {
    schema_version: 1,
    prior_execution_id: input.priorExecutionId,
    backend_origin: input.backendOrigin,
    result_summary: input.summary.slice(0, 1024),
    memory_slots: slots,
    total_bytes: Buffer.byteLength(stableJson(slots), "utf8")
  };
}
