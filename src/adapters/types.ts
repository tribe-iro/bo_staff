import type {
  ArtifactRecord,
  BackendName,
  ContinuationReference,
  ExecutionProfileOutcome,
  ExecutionProgressProjection,
  NormalizedExecutionRequest,
  ToolPolicyMode,
  UsageSummary
} from "../types.ts";
import type { PromptEnvelope } from "../engine/prompt-envelope.ts";
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

export interface CliAgentCapabilityContract {
  cwd_control: true;
  event_streaming: true;
  structured_output_normalization: "engine";
  cancellation: true;
  continuation: boolean;
  mcp_injection: boolean;
  custom_output_schema: boolean;
  builtin_tool_policy_modes: readonly ToolPolicyMode[];
}

export interface ProviderTerminalResult {
  continuation?: ContinuationReference;
  raw_output_text?: string;
  usage?: UsageSummary;
  exit_reason: "completed" | "failed" | "killed" | "timed_out";
  debug?: Record<string, unknown>;
}

export interface ProviderFailure {
  command: string;
  reason: "exited" | "timed_out" | "stdout_overflow" | "stderr_overflow" | "aborted";
  exit_code: number | null;
  stdout: string;
  stderr: string;
  interrupted_by?: string;
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

export interface CliAgentAdapter {
  readonly backend: BackendName;
  readonly capabilities: CliAgentCapabilityContract;
  execute(context: AdapterExecutionContext): AsyncIterable<AdapterEvent>;
}

export interface AdapterExecutionSummary {
  continuation_token?: string;
  raw_output_text?: string;
  usage?: UsageSummary;
  debug?: Record<string, unknown>;
}

export interface ProviderEventParser {
  onStdoutChunk(text: string): AdapterEvent[];
  onStderrChunk(text: string): AdapterEvent[];
  finish(input: {
    stdout: string;
    stderr: string;
  }): Promise<AdapterExecutionSummary> | AdapterExecutionSummary;
}
