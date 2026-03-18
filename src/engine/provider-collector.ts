import type { BackendAdapter } from "../adapters/types.ts";
import type { ResolvedExecutionProfile, NormalizedExecutionRequest } from "../types.ts";
import type { BoStaffRepository } from "../persistence/types.ts";
import type { SessionResolution } from "./session-manager.ts";
import type { WorkspaceRuntime } from "./workspace-manager.ts";
import type { ProviderAccumulation } from "./execution-state.ts";
import { projectAdapterEvent } from "./event-projection.ts";
import { EventLog } from "./event-log.ts";

export async function collectProviderResult(input: {
  adapter: BackendAdapter;
  repository: BoStaffRepository;
  executionId: string;
  requestId: string;
  request: NormalizedExecutionRequest;
  executionProfile: ResolvedExecutionProfile;
  session: SessionResolution;
  workspace: WorkspaceRuntime;
  prompt: string;
  signal: AbortSignal;
  log: EventLog;
  accumulation: ProviderAccumulation;
}): Promise<void> {
  for await (const event of input.adapter.execute({
    request_id: input.requestId,
    execution_id: input.executionId,
    signal: input.signal,
    request: input.request,
    execution_profile: input.executionProfile,
    session: input.session,
    workspace: input.workspace,
    prompt: input.prompt
  })) {
    await projectAdapterEvent({
      repository: input.repository,
      executionId: input.executionId,
      log: input.log,
      event,
      artifactMap: input.accumulation.artifactMap,
      controlGateMap: input.accumulation.controlGateMap
    });
    switch (event.type) {
      case "provider.started":
        input.accumulation.providerSessionId = event.provider_session_id ?? input.accumulation.providerSessionId;
        break;
      case "provider.progress":
        if (event.usage) {
          input.accumulation.providerUsage = { ...input.accumulation.providerUsage, ...event.usage };
        }
        break;
      case "provider.debug":
        input.accumulation.providerDebug = { ...(input.accumulation.providerDebug ?? {}), ...event.debug };
        break;
      case "provider.completed":
        input.accumulation.providerSessionId = event.result.provider_session_id ?? input.accumulation.providerSessionId;
        input.accumulation.providerUsage = event.result.usage ?? input.accumulation.providerUsage;
        input.accumulation.rawOutputText = event.result.raw_output_text ?? input.accumulation.rawOutputText;
        input.accumulation.providerDebug = {
          ...(input.accumulation.providerDebug ?? {}),
          ...(event.result.debug ?? {})
        };
        break;
      case "provider.failed":
        input.accumulation.providerFailed = {
          code: event.error.kind ?? "provider_failed",
          message: event.error.message,
          retryable: event.error.retryable
        };
        input.accumulation.providerDebug = {
          ...(input.accumulation.providerDebug ?? {}),
          ...(event.error.debug ?? {})
        };
        break;
      default:
        break;
    }
  }
}
