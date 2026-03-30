import type {
  ArtifactRecord,
  WorkspaceScopeStatus
} from "../core/index.ts";
import type { ExecutionStatus } from "../bomcp/types.ts";
import type { ErrorCategory, ErrorCode } from "../errors/taxonomy.ts";
import type { JsonSchema, ValidationIssue } from "./schema.ts";

// Re-export bomcp types as canonical event/envelope types
export type { BomcpMessageKind as BoStaffEventName } from "../bomcp/types.ts";
export type { BomcpEnvelope as BoStaffEvent } from "../bomcp/types.ts";

export const API_VERSION = "v0.2" as const;
export const BACKEND_NAMES = ["codex", "claude"] as const;
export type BackendName = (typeof BACKEND_NAMES)[number];
export const OUTPUT_FORMATS = ["message", "custom"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
export const OUTPUT_SCHEMA_ENFORCEMENTS = ["strict", "advisory"] as const;
export type OutputSchemaEnforcement = (typeof OUTPUT_SCHEMA_ENFORCEMENTS)[number];
export const TOOL_POLICY_MODES = ["default", "allowlist", "denylist"] as const;
export type ToolPolicyMode = (typeof TOOL_POLICY_MODES)[number];
export const MCP_TRANSPORTS = ["stdio", "sse"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];
export const MCP_APPROVAL_MODES = ["never", "always"] as const;
export type McpApprovalMode = (typeof MCP_APPROVAL_MODES)[number];
export type ExecutionProgressState = "running" | "finished";

export interface ExecutionProgressProjection {
  current_phase?: string;
  last_meaningful_message?: string;
  last_tool_command?: string;
  last_provider_event?: string;
  last_event_at?: string;
}

export interface UsageSummary {
  duration_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  turns?: number;
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

export interface ContinuationReference {
  backend: BackendName;
  token: string;
}

export interface BuiltinToolPolicy {
  mode: ToolPolicyMode;
  tools?: string[];
}

export interface McpServerSpec {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  require_approval?: McpApprovalMode;
}

export interface ToolConfiguration {
  builtin_policy?: BuiltinToolPolicy;
  mcp_servers?: McpServerSpec[];
}

export interface ExecutionRequestWorkspace {
  source_root: string;
  scope?: {
    mode?: "full" | "subpath";
    subpath?: string;
  };
}

export interface ExecutionRequest {
  backend: BackendName;
  execution_profile: {
    model: string;
    reasoning_effort?: string;
  };
  runtime?: {
    timeout_ms?: number;
    max_turns?: number;
  };
  task: {
    prompt: string;
    objective?: string;
    context?: Record<string, unknown>;
    attachments?: AttachmentInput[];
    constraints?: string[];
  };
  continuation?: ContinuationReference;
  workspace?: ExecutionRequestWorkspace;
  output?: {
    format?: OutputFormat;
    schema?: JsonSchema;
    schema_enforcement?: OutputSchemaEnforcement;
  };
  tool_configuration?: ToolConfiguration;
  lease?: {
    allowed_tools?: string[];
    timeout_seconds?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface NormalizedExecutionRequest {
  backend: BackendName;
  execution_profile: {
    model: string;
    reasoning_effort?: string;
  };
  runtime: {
    timeout_ms: number;
    max_turns?: number;
  };
  task: {
    prompt: string;
    objective?: string;
    context: Record<string, unknown>;
    attachments: Attachment[];
    constraints: string[];
  };
  continuation?: ContinuationReference;
  workspace: {
    kind: "provided";
    topology: "direct";
    source_root: string;
    scope: {
      mode: "full" | "subpath";
      subpath?: string;
    };
  } | {
    kind: "ephemeral";
    topology: "direct";
    source_root: null;
    scope: {
      mode: "full";
    };
  };
  output: {
    format: OutputFormat;
    schema: JsonSchema;
    schema_enforcement: OutputSchemaEnforcement;
  };
  tool_configuration?: {
    builtin_policy: BuiltinToolPolicy;
    mcp_servers: McpServerSpec[];
  };
  metadata: Record<string, unknown>;
}

export interface ExecutionProfileOutcome {
  model: string;
  reasoning_effort?: string;
}

export interface ActiveExecutionArtifact {
  artifact_id: string;
  kind: string;
  path: string;
  metadata?: Record<string, unknown>;
}

export interface ActiveExecutionResponse {
  execution_id: string;
  status: ExecutionStatus;
  backend: string;
  started_at: string;
  artifacts: ActiveExecutionArtifact[];
}

export interface CancelExecutionResponse {
  cancelled: true;
  execution_id: string;
}

export interface HealthResponse {
  status: "ok";
}

export interface WorkspaceSummary {
  topology: "direct";
  scope_status: WorkspaceScopeStatus;
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
  progress?: ExecutionProgressProjection;
}

export interface CompactResult {
  summary: string;
  payload: unknown;
  pending_items: string[];
}

export interface ExecutionError {
  code: ErrorCode;
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface ExecutionDebug {
  [key: string]: unknown;
}

export interface ExecutionValidations {
  schema?: {
    requested: OutputSchemaEnforcement;
    achieved: "native_constraint" | "substrate_validated" | "prompt_only";
    passed: boolean;
    issues?: ValidationIssue[];
  };
}

export interface ToolConfigurationOutcome {
  builtin_policy_honored: boolean;
  mcp_servers_requested: number;
  mcp_servers_active: number;
  failed_mcp_servers?: string[];
}

export interface ExecutionResponse {
  api_version: typeof API_VERSION;
  request_id: string;
  execution: ExecutionSummary;
  execution_profile: ExecutionProfileOutcome;
  continuation?: ContinuationReference;
  workspace: WorkspaceSummary;
  result: CompactResult;
  artifacts: ArtifactRecord[];
  usage?: UsageSummary;
  errors: ExecutionError[];
  validations?: ExecutionValidations;
  tool_configuration_outcome?: ToolConfigurationOutcome;
  debug?: ExecutionDebug;
}
