// BO-MCP type foundation — single source of truth for all protocol types.

// ---------------------------------------------------------------------------
// Message envelope
// ---------------------------------------------------------------------------

export interface BomcpSender {
  type: "agent" | "runtime";
  id: string;
}

export interface BomcpEnvelope<P = unknown> {
  message_id: string;
  execution_id?: string;
  kind: BomcpMessageKind;
  sequence: number;
  timestamp: string;
  sender: BomcpSender;
  request_id?: string;
  correlation_id?: string;
  reply_to?: string;
  payload: P;
}

// ---------------------------------------------------------------------------
// Message kinds — exhaustive union
// ---------------------------------------------------------------------------

export type BomcpMessageKind =
  // Control
  | "control.handoff"
  // Artifact
  | "artifact.register"
  | "artifact.registered"
  | "artifact.registration_rejected"
  | "artifact.require"
  | "artifact.available"
  | "artifact.missing"
  | "artifact.superseded"
  // Progress
  | "progress.update"
  | "progress.heartbeat"
  | "progress.chunk"
  | "progress.usage"
  // Execution lifecycle
  | "execution.started"
  | "execution.completed"
  | "execution.failed"
  | "execution.cancelled"
  // System
  | "system.error"
  | "system.lease_expired";

// ---------------------------------------------------------------------------
// Agent-facing tool parameter types
// ---------------------------------------------------------------------------

export const BOMCP_HANDOFF_KINDS = [
  "blocked",
  "needs_input",
  "needs_approval",
  "retry",
  "fresh_context",
  "continue_with_node",
  "continue_with_prompt",
  "completed",
] as const;

export type BomcpHandoffKind = (typeof BOMCP_HANDOFF_KINDS)[number];

export interface HandoffTarget {
  node_id?: string;
  prompt_id?: string;
}

export interface HandoffInputRequest {
  kind: string;
  prompt: string;
}

export interface ControlHandoffParams {
  kind: BomcpHandoffKind;
  reason_code?: string;
  description?: string;
  next?: HandoffTarget;
  input_request?: HandoffInputRequest;
  missing_refs?: string[];
  payload?: Record<string, unknown>;
}

export interface ArtifactRegisterParams {
  kind: string;
  path: string;
  metadata?: Record<string, unknown>;
}

export interface ArtifactRequireParams {
  kind: string;
  path: string;
}

export interface ProgressUpdateParams {
  phase?: string;
  percent?: number;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Agent-facing tool response types
// ---------------------------------------------------------------------------

export interface HandoffAckResponse {
  acknowledged: true;
  kind: BomcpHandoffKind;
}

export type ArtifactRegisterResponse =
  | { artifact_id: string; status: "registered" }
  | { status: "rejected"; reason: string };

export type ArtifactRequireResponse =
  | { status: "available"; path: string }
  | { status: "missing" }
  | { status: "rejected"; reason: string };

export interface ProgressAckResponse {
  acknowledged: true;
}

// ---------------------------------------------------------------------------
// Lease model
// ---------------------------------------------------------------------------

export const BOMCP_TOOL_NAMES = [
  "bomcp.control.handoff",
  "bomcp.artifact.register",
  "bomcp.artifact.require",
  "bomcp.progress.update",
] as const;

export type BomcpToolName = (typeof BOMCP_TOOL_NAMES)[number];

export interface ExecutionLease {
  execution_id: string;
  allowed_tools: readonly string[];
  timeout_seconds?: number;
  issued_at: string;
  expires_at?: string;
}

export interface MaterializationPlanEntry {
  change: "add" | "modify" | "delete" | "rename" | "type_change";
  path: string;
  previous_path?: string;
  digest?: string;
}

// ---------------------------------------------------------------------------
// Ephemeral execution state
// ---------------------------------------------------------------------------

export type ExecutionStatus =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface EphemeralExecutionState {
  execution_id: string;
  backend: string;
  agent_id?: string;
  status: ExecutionStatus;
  lease: ExecutionLease;
  artifacts: Map<string, { artifact_id: string; kind: string; path: string; metadata?: Record<string, unknown> }>;
  processed_request_ids: Map<string, unknown>; // request_id -> cached response
  started_at: string;
}

// ---------------------------------------------------------------------------
// IPC protocol (bomcp-server <-> execution manager)
// ---------------------------------------------------------------------------

export interface IpcToolCallRequest {
  type: "tool_call";
  tool_name: string;
  params: unknown;
  request_id: string;
}

export interface IpcToolCallResponse {
  type: "tool_response";
  request_id: string;
  result?: unknown;
  error?: { code: string; message: string };
}
