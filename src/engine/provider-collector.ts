import type { BackendAdapter, ProviderTerminalResult, ProviderFailure } from "../adapters/types.ts";
import type { ExecutionProfileOutcome, NormalizedExecutionRequest } from "../types.ts";
import type { WorkspaceRuntime } from "./workspace-manager.ts";
import type { PromptEnvelope } from "./prompt-envelope.ts";
import type { ControllerStream } from "../bomcp/controller-stream.ts";
import type { EphemeralExecutionState } from "../bomcp/types.ts";
import { projectAdapterEvent } from "./event-projection.ts";

export interface ProviderResult {
  terminal?: ProviderTerminalResult;
  failure?: ProviderFailure;
}

export async function collectProviderResult(input: {
  adapter: BackendAdapter;
  executionId: string;
  requestId: string;
  request: NormalizedExecutionRequest;
  executionProfile: ExecutionProfileOutcome;
  workspace: WorkspaceRuntime;
  prompt: PromptEnvelope;
  signal: AbortSignal;
  abortController: AbortController;
  stream: ControllerStream;
  state: EphemeralExecutionState;
  bomcpServerConfig?: { command: string; args: string[]; env: Record<string, string> };
}): Promise<ProviderResult> {
  const result: ProviderResult = {};
  let turnCount = 0;

  for await (const event of input.adapter.execute({
    request_id: input.requestId,
    execution_id: input.executionId,
    signal: input.signal,
    request: input.request,
    execution_profile: input.executionProfile,
    continuation: input.request.continuation,
    workspace: input.workspace,
    prompt: input.prompt,
    bomcp_server_config: input.bomcpServerConfig,
  })) {
    if (event.type === "provider.started") {
      input.state.agent_id = event.provider_session_id ?? input.state.agent_id;
    }

    await projectAdapterEvent({
      stream: input.stream,
      event,
      agentId: input.state.agent_id ?? "agent",
    });

    switch (event.type) {
      case "provider.turn_boundary":
        turnCount = event.turn_number;
        if (input.request.runtime.max_turns !== undefined && turnCount > input.request.runtime.max_turns) {
          input.abortController.abort("turn_limit_exceeded");
        }
        break;

      case "provider.completed":
        result.terminal = event.result;
        break;

      case "provider.failed":
        result.failure = event.error;
        break;

      default:
        break;
    }
  }

  return result;
}
