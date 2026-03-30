import type { ControllerStream } from "../bomcp/controller-stream.ts";
import type { EphemeralExecutionState } from "../bomcp/types.ts";
import type { WorkspaceRuntime } from "./workspace-manager.ts";
import type { ProviderResult } from "./provider-collector.ts";
import type { NormalizedExecutionRequest } from "../types.ts";
import { WorkspaceManager } from "./workspace-manager.ts";
import { reportInternalError } from "../internal-reporting.ts";
import { parseCompactOutput } from "../bomcp/output.ts";
import { validateAgainstSchema } from "../schema/validator.ts";

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
    state.status = "failed";
    const failed = await stream.emitRuntime("execution.failed", {
      execution_id: state.execution_id,
      status: "failed",
      message: providerResult.failure.message,
    });
    if (!failed.delivered) {
      reportInternalError("execution.failed.dropped", new Error("execution.failed was not delivered"), {
        execution_id: state.execution_id,
      });
    }
    await cleanupWorktree(input.workspaceManager, workspace);
    return;
  }

  const outputValidationFailure = validateTerminalOutput(providerResult, request);
  if (outputValidationFailure) {
    state.status = "failed";
    const failed = await stream.emitRuntime("execution.failed", {
      execution_id: state.execution_id,
      status: "failed",
      message: outputValidationFailure,
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
    ...(providerResult.terminal?.raw_output_text ? { output: providerResult.terminal.raw_output_text } : {}),
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

function validateTerminalOutput(
  providerResult: ProviderResult,
  request: NormalizedExecutionRequest,
): string | undefined {
  const rawText = providerResult.terminal?.raw_output_text;
  if (!rawText) {
    return "provider returned no terminal output";
  }

  const parsed = parseCompactOutput({ raw_text: rawText });
  if (parsed.status !== "valid" || !parsed.value) {
    return "provider output did not contain valid bo_staff compact JSON";
  }

  const schemaIssues = validateAgainstSchema(request.output.schema, parsed.value.payload, "$.payload");
  if (schemaIssues.length === 0 || request.output.schema_enforcement === "advisory") {
    return undefined;
  }

  const summary = schemaIssues.slice(0, 3).map((issue) => `${issue.path} ${issue.message}`).join("; ");
  return `provider output did not satisfy the requested schema: ${summary}`;
}
