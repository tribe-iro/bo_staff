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
