import type {
  ArtifactRecord,
  CapabilityDiagnostic,
  CapabilityName,
  CapabilityOutcome,
  ControlGateRecord,
  ContinuityKind,
  ExecutionStatus,
  MaterializationPlanEntry,
  SessionMode,
  WorkspaceMaterializationStatus,
  WorkspaceScopeStatus,
  WorkspaceWritebackStatus
} from "../core/index.ts";
import type { PerformanceTier, ReasoningTier } from "../engine/types.ts";
import type { JsonSchema } from "./schema.ts";

export const BACKEND_NAMES = ["codex", "claude"] as const;
export type BackendName = (typeof BACKEND_NAMES)[number];
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export const SELECTION_MODES = ["managed", "pinned", "override"] as const;
export type SelectionMode = (typeof SELECTION_MODES)[number];
export type DurabilityKind = "persistent" | "ephemeral";
export const OUTPUT_FORMATS = ["message", "custom"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
export const POLICY_ISOLATION_MODES = ["default", "require_workspace_isolation"] as const;
export const POLICY_APPROVAL_MODES = ["default", "forbid_interactive_approvals"] as const;
export const POLICY_FILESYSTEM_MODES = ["default", "read_only", "workspace_write", "full_access"] as const;
export type ExecutionProgressState = "running" | "waiting_for_control_gate" | "finished";
export const EXECUTION_PERSISTENCE_STATUSES = ["persisted", "failed", "not_attempted"] as const;
export type ExecutionPersistenceStatus = (typeof EXECUTION_PERSISTENCE_STATUSES)[number];

export interface ExecutionPolicy {
  isolation: (typeof POLICY_ISOLATION_MODES)[number];
  approvals: (typeof POLICY_APPROVAL_MODES)[number];
  filesystem: (typeof POLICY_FILESYSTEM_MODES)[number];
}

export interface ContinuationCapsuleMemorySlotRememberedToken {
  key: "remembered_token";
  value: string;
}

export interface ContinuationCapsuleMemorySlotArtifactRefs {
  key: "artifact_refs";
  value: string[];
}

export type ContinuationCapsuleMemorySlot =
  | ContinuationCapsuleMemorySlotRememberedToken
  | ContinuationCapsuleMemorySlotArtifactRefs;

export interface ContinuationCapsule {
  schema_version: 1;
  prior_execution_id: string;
  backend_origin: BackendName;
  result_summary: string;
  memory_slots: ContinuationCapsuleMemorySlot[];
  total_bytes: number;
}

export interface UsageSummary {
  duration_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
}

export interface GatewayHttpResponse<T> {
  body: T;
  http_status: number;
  headers: Record<string, string>;
  request_id?: string;
}

export interface InlineAttachmentInput {
  name: string;
  content?: string;
  mime_type?: string;
  description?: string;
}

export interface PathAttachmentInput {
  name: string;
  path?: string;
  mime_type?: string;
  description?: string;
}

export type AttachmentInput = InlineAttachmentInput | PathAttachmentInput;

export interface InlineAttachment {
  kind: "inline";
  name: string;
  content: string;
  mime_type?: string;
  description?: string;
}

export interface PathAttachment {
  kind: "path";
  name: string;
  path: string;
  mime_type?: string;
  description?: string;
}

export type Attachment = InlineAttachment | PathAttachment;

export interface ExecutionRequestWorkspace {
  source_root: string;
  scope?: {
    mode?: "full" | "subpath";
    subpath?: string;
  };
  writeback?: "apply" | "discard";
}

export interface ExecutionRequest {
  backend: BackendName;
  execution_profile?: {
    performance_tier?: PerformanceTier;
    reasoning_tier?: ReasoningTier;
    selection_mode?: SelectionMode;
    pin?: string;
    override?: string;
  };
  runtime?: {
    timeout_ms?: number;
  };
  task: {
    prompt: string;
    objective?: string;
    context?: Record<string, unknown>;
    attachments?: AttachmentInput[];
    constraints?: string[];
  };
  session?: {
    mode?: SessionMode;
    handle?: string | null;
  };
  workspace?: ExecutionRequestWorkspace;
  policy?: Partial<ExecutionPolicy>;
  output?: {
    format?: OutputFormat;
    schema?: JsonSchema;
  };
  hints?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface NormalizedExecutionRequest {
  backend: BackendName;
  execution_profile: {
    performance_tier: PerformanceTier;
    reasoning_tier: ReasoningTier;
    selection_mode: SelectionMode;
    pin?: string;
    override?: string;
  };
  runtime: {
    timeout_ms: number;
  };
  task: {
    prompt: string;
    objective?: string;
    context: Record<string, unknown>;
    attachments: Attachment[];
    constraints: string[];
  };
  session: {
    mode: SessionMode;
    handle: string | null;
  };
  workspace: {
    kind: "provided";
    topology: "direct" | "git_isolated";
    source_root: string;
    scope: {
      mode: "full" | "subpath";
      subpath?: string;
    };
    writeback: "apply" | "discard";
    sandbox: SandboxMode;
  } | {
    kind: "ephemeral";
    topology: "direct";
    source_root: null;
    scope: {
      mode: "full";
    };
    writeback: "discard";
    sandbox: SandboxMode;
  };
  policy: ExecutionPolicy;
  output: {
    format: OutputFormat;
    schema: JsonSchema;
  };
  hints: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface ResolvedExecutionProfile {
  requested_performance_tier: PerformanceTier;
  requested_reasoning_tier: ReasoningTier;
  selection_mode: SelectionMode;
  resolved_backend_model: string;
  resolved_backend_reasoning_control?: string;
  resolution_source: SelectionMode;
}

export interface SessionSummary {
  handle: string | null;
  continued_from?: string;
  forked_from?: string;
  continuity_kind: ContinuityKind;
  durability_kind: DurabilityKind;
}

export interface WorkspaceSummary {
  topology: "direct" | "git_isolated";
  scope_status: WorkspaceScopeStatus;
  writeback_status: WorkspaceWritebackStatus;
  materialization_status: WorkspaceMaterializationStatus;
  diagnostics?: WorkspaceDiagnostics;
}

export interface WorkspaceDiagnostics {
  skipped_entry_count?: number;
  skipped_entries?: MaterializationPlanEntry[];
  materialization_errors?: string[];
}

export interface ExecutionSummary {
  execution_id: string | null;
  status: ExecutionStatus;
  terminal: boolean;
  degraded: boolean;
  retryable: boolean;
  started_at: string;
  updated_at: string;
  completed_at?: string;
  progress_state?: ExecutionProgressState;
}

export interface CompactResult {
  summary: string;
  payload: unknown;
  pending_items: string[];
}

export interface ExecutionError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export interface ExecutionDebug {
  capability_diagnostics?: Record<CapabilityName, CapabilityDiagnostic>;
  [key: string]: unknown;
}

export interface ExecutionPersistenceSummary {
  status: ExecutionPersistenceStatus;
  reason?: string;
}

export interface ExecutionResponse {
  api_version: "v0.1";
  request_id: string;
  execution: ExecutionSummary;
  persistence: ExecutionPersistenceSummary;
  execution_profile: ResolvedExecutionProfile;
  session: SessionSummary;
  workspace: WorkspaceSummary;
  capabilities: Record<CapabilityName, CapabilityOutcome>;
  result: CompactResult;
  artifacts: ArtifactRecord[];
  control_gates: {
    pending: ControlGateRecord[];
    resolved: ControlGateRecord[];
  };
  usage?: UsageSummary;
  errors: ExecutionError[];
  debug?: ExecutionDebug;
}

export type SessionRecordSummary = Omit<SessionSummary, "handle"> & {
  handle: string;
  backend: BackendName;
  created_at: string;
  updated_at: string;
  latest_execution_id?: string;
  latest_status?: ExecutionStatus;
};

export interface SessionListResponse {
  sessions: SessionRecordSummary[];
  next_cursor?: string;
}

export interface ExecutionEventListResponse {
  events: BoStaffEvent[];
  next_cursor?: string;
}

export type BoStaffEventName =
  | "execution.accepted"
  | "execution.started"
  | "execution.progress_initialized"
  | "execution.progressed"
  | "execution.degraded"
  | "execution.awaiting_control_gate"
  | "control_gate.requested"
  | "control_gate.resolved"
  | "workspace.updated"
  | "artifact.produced"
  | "execution.snapshot"
  | "execution.completed"
  | "execution.failed"
  | "execution.rejected";

export interface BoStaffEvent<T = Record<string, unknown>> {
  event: BoStaffEventName;
  request_id: string;
  execution_id: string | null;
  emitted_at: string;
  data: T;
}
