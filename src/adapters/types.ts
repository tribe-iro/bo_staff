import type {
  ArtifactRecord,
  BackendName,
  ContinuationReference,
  ExecutionError,
  ExecutionProfileOutcome,
  ExecutionProgressProjection,
  NormalizedExecutionRequest,
  ToolConfigurationOutcome,
  UsageSummary
} from "../types.ts";
import type { PromptEnvelope } from "../engine/prompt-envelope.ts";
import type { ErrorCode } from "../errors/taxonomy.ts";
import type { WorkspaceRuntime } from "../engine/workspace-manager.ts";

export interface RenderedPrompt {
  stdin_text: string;
  extra_args?: string[];
}

export interface AdapterExecutionContext {
  request_id: string;
  execution_id: string;
  signal: AbortSignal;
  request: NormalizedExecutionRequest;
  execution_profile: ExecutionProfileOutcome;
  continuation?: ContinuationReference;
  workspace: WorkspaceRuntime;
  prompt: PromptEnvelope;
  bomcp_server_config?: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
}

export interface ProviderTerminalResult {
  continuation?: ContinuationReference;
  raw_output_text?: string;
  usage?: UsageSummary;
  schema_enforcement_applied?: boolean;
  tool_configuration_outcome?: ToolConfigurationOutcome;
  exit_reason: "completed" | "failed" | "killed" | "timed_out";
  debug?: Record<string, unknown>;
}

export interface ProviderFailure {
  message: string;
  retryable?: boolean;
  kind?: ErrorCode;
  debug?: Record<string, unknown>;
  details?: Record<string, unknown>;
}

export type AdapterEvent =
  | { type: "provider.started"; provider_session_id?: string }
  | { type: "provider.progress"; message?: string; usage?: Partial<UsageSummary>; progress?: ExecutionProgressProjection }
  | { type: "provider.turn_boundary"; turn_number: number }
  | { type: "provider.output.chunk"; text: string }
  | { type: "provider.artifact.upsert"; artifact: ArtifactRecord }
  | { type: "provider.debug"; debug: Record<string, unknown> }
  | { type: "provider.completed"; result: ProviderTerminalResult }
  | { type: "provider.failed"; error: ProviderFailure };

export interface BackendAdapter {
  readonly backend: BackendName;
  execute(context: AdapterExecutionContext): AsyncIterable<AdapterEvent>;
}

export interface AdapterExecutionSummary {
  continuation?: ContinuationReference;
  raw_output_text?: string;
  usage?: UsageSummary;
  schema_enforcement_applied?: boolean;
  tool_configuration_outcome?: ToolConfigurationOutcome;
  debug?: Record<string, unknown>;
}

export interface ProviderEventParser {
  onStdoutChunk(text: string): AdapterEvent[];
  onStderrChunk(text: string): AdapterEvent[];
  finish(input: {
    context: AdapterExecutionContext;
    stdout: string;
    stderr: string;
  }): Promise<AdapterExecutionSummary> | AdapterExecutionSummary;
}
