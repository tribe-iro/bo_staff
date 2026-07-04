import type { ControllerStream } from "../bomcp/controller-stream.ts";
import type { EphemeralExecutionState } from "./types.ts";
import type { WorkspaceRuntime } from "./workspace-manager.ts";
import type { ProviderResult } from "./provider-collector.ts";
import type { NormalizedExecutionRequest } from "../types.ts";
import { WorkspaceManager } from "./workspace-manager.ts";
import { reportInternalError } from "../internal-reporting.ts";
import { classifyProviderFailure, validateTerminalOutput } from "./provider-policy.ts";

export async function finalizeExecution(input: {
  stream: ControllerStream;
  workspaceManager: WorkspaceManager;
  state: EphemeralExecutionState;
  workspace: WorkspaceRuntime;
  request: NormalizedExecutionRequest;
  providerResult: ProviderResult;
}): Promise<void> {
  const { stream, state, workspace, providerResult, request } = input;

  if (providerResult.failure) {
    const failure = classifyProviderFailure(providerResult.failure);
    state.status = "failed";
    const failed = await stream.emitRuntime("execution.failed", {
      execution_id: state.execution_id,
      status: "failed",
      code: failure.error.code,
      message: failure.error.message,
      retryable: failure.error.retryable,
    });
    if (!failed.delivered) {
      reportInternalError("execution.failed.dropped", new Error("execution.failed was not delivered"), {
        execution_id: state.execution_id,
      });
    }
    await cleanupWorktree(input.workspaceManager, workspace);
    return;
  }

  const terminalOutput = validateTerminalOutput({
    request,
    raw_output_text: providerResult.terminal?.raw_output_text,
  });
  if (terminalOutput.error) {
    state.status = "failed";
    const failed = await stream.emitRuntime("execution.failed", {
      execution_id: state.execution_id,
      status: "failed",
      code: terminalOutput.error.code,
      message: terminalOutput.error.message,
      retryable: terminalOutput.error.retryable,
    });
    if (!failed.delivered) {
      reportInternalError("execution.failed.dropped", new Error("execution.failed was not delivered"), {
        execution_id: state.execution_id,
      });
    }
    await cleanupWorktree(input.workspaceManager, workspace);
    return;
  }

  state.status = "completed";
  const completed = await stream.emitRuntime("execution.completed", {
    execution_id: state.execution_id,
    status: "completed",
    ...(terminalOutput.output ? { output: terminalOutput.output } : {}),
    ...(providerResult.terminal?.usage ? { usage: providerResult.terminal.usage } : {}),
    ...(providerResult.terminal?.continuation ? { continuation: providerResult.terminal.continuation } : {}),
    artifacts: [...state.artifacts.values()],
  });
  if (!completed.delivered) {
    reportInternalError("execution.completed.dropped", new Error("execution.completed was not delivered"), {
      execution_id: state.execution_id,
    });
  }
  await cleanupWorktree(input.workspaceManager, workspace);
}

async function cleanupWorktree(manager: WorkspaceManager, workspace: WorkspaceRuntime): Promise<void> {
  try {
    await manager.cleanup(workspace);
  } catch { /* best-effort cleanup */ }
}
