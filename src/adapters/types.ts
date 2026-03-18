import type {
  ArtifactRecord,
  BackendName,
  ControlGateRecord,
  ExecutionError,
  NormalizedExecutionRequest,
  ResolvedExecutionProfile,
  UsageSummary
} from "../types.ts";
import type { SessionResolution } from "../engine/session-manager.ts";
import type { WorkspaceRuntime } from "../engine/workspace-manager.ts";

export interface AdapterExecutionContext {
  request_id: string;
  execution_id: string;
  signal: AbortSignal;
  request: NormalizedExecutionRequest;
  execution_profile: ResolvedExecutionProfile;
  session: SessionResolution;
  workspace: WorkspaceRuntime;
  prompt: string;
}

export interface ProviderTerminalResult {
  provider_session_id?: string;
  raw_output_text?: string;
  usage?: UsageSummary;
  exit_reason: "completed" | "failed" | "killed" | "timed_out";
  debug?: Record<string, unknown>;
}

export interface ProviderFailure {
  message: string;
  retryable?: boolean;
  kind?: string;
  debug?: Record<string, unknown>;
}

export type AdapterEvent =
  | { type: "provider.started"; provider_session_id?: string }
  | { type: "provider.progress"; message?: string; usage?: Partial<UsageSummary> }
  | { type: "provider.output.chunk"; text: string }
  | { type: "provider.control_gate.upsert"; gate: ControlGateRecord }
  | { type: "provider.control_gate.resolved"; control_gate_id: string; resolved_at: string; resolution: string }
  | { type: "provider.artifact.upsert"; artifact: ArtifactRecord }
  | { type: "provider.debug"; debug: Record<string, unknown> }
  | { type: "provider.completed"; result: ProviderTerminalResult }
  | { type: "provider.failed"; error: ProviderFailure };

export interface BackendAdapter {
  readonly backend: BackendName;
  execute(context: AdapterExecutionContext): AsyncIterable<AdapterEvent>;
}

export interface AdapterExecutionSummary {
  provider_session_id?: string;
  raw_output_text?: string;
  usage?: UsageSummary;
  debug?: Record<string, unknown>;
}
