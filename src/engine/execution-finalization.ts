import { parseCompactOutput } from "../compat/policies.ts";
import { UpstreamRuntimeError } from "../errors.ts";
import { reportInternalError } from "../internal-reporting.ts";
import type {
  BoStaffEvent,
  CapabilityDiagnostic,
  CapabilityName,
  CapabilityOutcome,
  ExecutionError,
  ExecutionResponse,
  NormalizedExecutionRequest,
  ResolvedExecutionProfile
} from "../types.ts";
import type { BoStaffRepository, CommitTerminalExecutionInput, ExecutionRecord } from "../persistence/types.ts";
import {
  buildFinalSessionRecord,
  buildPersistenceSummary,
  buildSessionSummary,
  buildWorkspaceRecord,
  buildWorkspaceSummary,
  formatExecutionError,
  isExecutionDegraded,
  mergeExecutionDebug,
  pruneBeforeIso,
  progressStateForStatus,
  uniqueArtifacts,
  type ProviderAccumulation
} from "./execution-state.ts";
import { partitionControlGates } from "./control-gate-manager.ts";
import { buildLifecycleTerminalEvent, buildResponseEvent } from "./event-projection.ts";
import { nowIso } from "../utils.ts";
import type { SessionResolution } from "./session-manager.ts";
import type { WorkspaceManager, WorkspaceRuntime } from "./workspace-manager.ts";
import { EventLog } from "./event-log.ts";

interface ExecutionContextLike {
  executionId: string;
  requestId: string;
  request: NormalizedExecutionRequest;
  log: EventLog;
  executionProfile: ResolvedExecutionProfile;
  session: SessionResolution;
  workspace: WorkspaceRuntime;
  guaranteeResolution: {
    outcomes: Record<CapabilityName, CapabilityOutcome>;
    diagnostics: Record<CapabilityName, CapabilityDiagnostic>;
  };
}

export async function finalizeResolvedExecution(input: {
  repository: BoStaffRepository;
  workspaceManager: WorkspaceManager;
  context: ExecutionContextLike;
  runningRecord: ExecutionRecord;
  startedAt: string;
  provider: ProviderAccumulation;
}): Promise<{
  httpStatus: number;
  response: ExecutionResponse;
  workspace: WorkspaceRuntime;
}> {
  const parsedOutput = input.provider.providerFailed
    ? undefined
    : parseCompactOutput({
      raw_text: input.provider.rawOutputText,
      payload_schema: input.context.request.output.schema
    });
  const outputErrors: ExecutionError[] = parsedOutput && parsedOutput.issues.length > 0
    ? [{
      code: parsedOutput.status === "missing" ? "missing_backend_output" : "invalid_backend_output",
      message: parsedOutput.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")
    }]
    : [];
  const errors = input.provider.providerFailed ? [input.provider.providerFailed] : outputErrors;
  const completedWorkspace = errors.length === 0
    ? await input.workspaceManager.materialize({
      request: input.context.request,
      runtime: input.context.workspace
    })
    : input.context.workspace;
  const controlGates = partitionControlGates([...input.provider.controlGateMap.values()]);
  const status = errors.length > 0
    ? "failed"
    : controlGates.pending.length > 0
      ? "awaiting_control_gate"
      : ((parsedOutput?.value?.pending_items.length ?? 0) > 0)
        ? "partial"
        : "completed";
  const completedAt = nowIso();
  const response = buildExecutionResponse({
    requestId: input.context.requestId,
    executionId: input.context.executionId,
    status,
    startedAt: input.startedAt,
    updatedAt: completedAt,
    completedAt: status !== "awaiting_control_gate" ? completedAt : undefined,
    degraded: isExecutionDegraded(input.context.guaranteeResolution.outcomes, completedWorkspace),
    retryable: errors.some((error) => error.retryable === true),
    executionProfile: input.context.executionProfile,
    session: buildSessionSummary(input.context.session),
    workspace: buildWorkspaceSummary(completedWorkspace),
    capabilities: input.context.guaranteeResolution.outcomes,
    result: parsedOutput?.value ?? {
      summary: errors.length > 0 ? "Execution failed before a valid bo_staff result was produced." : "",
      payload: {},
      pending_items: []
    },
    artifacts: [...input.provider.artifactMap.values(), ...(parsedOutput?.value?.artifacts ?? [])].filter(uniqueArtifacts),
    controlGates,
    usage: input.provider.providerUsage,
    errors,
    debug: mergeExecutionDebug(input.provider.providerDebug, input.context.guaranteeResolution.diagnostics)
  });

  const persisted = await persistTerminalExecution({
    repository: input.repository,
    log: input.context.log,
    response,
    lifecycleStatus: status,
    terminalCommitInput: {
      session_record: buildFinalSessionRecord({
        session: input.context.session,
        request: input.context.request,
        backend: input.context.request.backend,
        executionId: input.context.executionId,
        providerSessionId: input.provider.providerSessionId,
        response
      }),
      execution_record: {
        ...input.runningRecord,
        status: response.execution.status,
        degraded: response.execution.degraded,
        retryable: response.execution.retryable,
        updated_at: response.execution.updated_at,
        completed_at: response.execution.completed_at,
        usage: input.provider.providerUsage,
        provider_session_id: input.provider.providerSessionId
      },
      usage: input.provider.providerUsage,
      artifacts: response.artifacts,
      control_gates: [...response.control_gates.pending, ...response.control_gates.resolved],
      capability_outcomes: response.capabilities,
      workspace_record: buildWorkspaceRecord(
        input.context.executionId,
        input.context.session,
        completedWorkspace,
        response.workspace
      )
    }
  });

  await cleanupWorkspace(input.workspaceManager, completedWorkspace, {
    execution_id: input.context.executionId,
    request_id: input.context.requestId,
    phase: "resolved"
  });

  return {
    httpStatus: persisted.response.persistence.status === "failed"
      ? 500
      : response.execution.status === "failed"
        ? 502
        : 200,
    response: persisted.response,
    workspace: completedWorkspace
  };
}

export async function finalizeRuntimeFailure(input: {
  repository: BoStaffRepository;
  workspaceManager: WorkspaceManager;
  context: ExecutionContextLike;
  runningRecord: ExecutionRecord;
  startedAt: string;
  error: unknown;
  provider: ProviderAccumulation;
}): Promise<{ httpStatus: number; response: ExecutionResponse }> {
  const completedAt = nowIso();
  const controlGates = partitionControlGates([...input.provider.controlGateMap.values()]);
  const response = buildExecutionResponse({
    requestId: input.context.requestId,
    executionId: input.context.executionId,
    status: "failed",
    startedAt: input.startedAt,
    updatedAt: completedAt,
    completedAt,
    degraded: isExecutionDegraded(input.context.guaranteeResolution.outcomes, input.context.workspace),
    retryable: input.error instanceof UpstreamRuntimeError && input.error.kind === "rate_limit",
    executionProfile: input.context.executionProfile,
    session: buildSessionSummary(input.context.session),
    workspace: buildWorkspaceSummary(input.context.workspace),
    capabilities: input.context.guaranteeResolution.outcomes,
    result: {
      summary: "Execution failed.",
      payload: {},
      pending_items: []
    },
    artifacts: [...input.provider.artifactMap.values()],
    controlGates,
    usage: input.provider.providerUsage,
    errors: [formatExecutionError(input.error)],
    debug: mergeExecutionDebug(
      {
        ...(input.provider.providerDebug ?? {}),
        ...(input.error instanceof Error ? { error: input.error.message } : {})
      },
      input.context.guaranteeResolution.diagnostics
    )
  });

  const persisted = await persistTerminalExecution({
    repository: input.repository,
    log: input.context.log,
    response,
    lifecycleStatus: "failed",
    failureEventMessage: input.error instanceof Error ? input.error.message : String(input.error),
    terminalCommitInput: {
      session_record: buildFinalSessionRecord({
        session: input.context.session,
        request: input.context.request,
        backend: input.context.request.backend,
        executionId: input.context.executionId,
        providerSessionId: input.provider.providerSessionId,
        response
      }),
      execution_record: {
        ...input.runningRecord,
        status: "failed",
        degraded: response.execution.degraded,
        retryable: response.execution.retryable,
        updated_at: completedAt,
        completed_at: completedAt,
        usage: input.provider.providerUsage,
        provider_session_id: input.provider.providerSessionId
      },
      usage: input.provider.providerUsage,
      artifacts: response.artifacts,
      control_gates: [...response.control_gates.pending, ...response.control_gates.resolved],
      capability_outcomes: response.capabilities,
      workspace_record: buildWorkspaceRecord(
        input.context.executionId,
        input.context.session,
        input.context.workspace,
        response.workspace
      )
    }
  });

  await cleanupWorkspace(input.workspaceManager, input.context.workspace, {
    execution_id: input.context.executionId,
    request_id: input.context.requestId,
    phase: "failure"
  });

  return {
    httpStatus: persisted.response.persistence.status === "failed"
      ? 500
      : input.error instanceof UpstreamRuntimeError
        ? input.error.httpStatus
        : 500,
    response: persisted.response
  };
}

export async function emitImmediateExecutionResponse(input: {
  repository: BoStaffRepository;
  sessionlessExecutionRetentionMs: number;
  context: {
    executionId: string;
    requestId: string;
    request: NormalizedExecutionRequest;
    log: EventLog;
  };
  httpStatus: number;
  response: ExecutionResponse;
  terminalEvent: "execution.rejected" | "execution.failed";
}): Promise<{ httpStatus: number; response: ExecutionResponse }> {
  const message = input.response.errors[0]?.message ?? input.response.result.summary;
  const persisted = await persistImmediateExecutionResponse({
    repository: input.repository,
    sessionlessExecutionRetentionMs: input.sessionlessExecutionRetentionMs,
    context: input.context,
    response: input.response,
    terminalEvent: input.terminalEvent,
    terminalEventMessage: message
  });
  return {
    httpStatus: persisted.response.persistence.status === "failed" ? 500 : input.httpStatus,
    response: persisted.response
  };
}

function buildExecutionResponse(input: {
  requestId: string;
  executionId: string;
  status: ExecutionResponse["execution"]["status"];
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  degraded: boolean;
  retryable: boolean;
  executionProfile: ExecutionResponse["execution_profile"];
  session: ExecutionResponse["session"];
  workspace: ExecutionResponse["workspace"];
  capabilities: ExecutionResponse["capabilities"];
  result: ExecutionResponse["result"];
  artifacts: ExecutionResponse["artifacts"];
  controlGates: ExecutionResponse["control_gates"];
  usage?: ExecutionResponse["usage"];
  errors: ExecutionResponse["errors"];
  debug?: ExecutionResponse["debug"];
}): ExecutionResponse {
  return {
    api_version: "v0.1",
    request_id: input.requestId,
    execution: {
      execution_id: input.executionId,
      status: input.status,
      terminal: input.status !== "awaiting_control_gate",
      degraded: input.degraded,
      retryable: input.retryable,
      started_at: input.startedAt,
      updated_at: input.updatedAt,
      completed_at: input.completedAt,
      progress_state: progressStateForStatus(input.status)
    },
    persistence: buildPersistenceSummary("not_attempted"),
    execution_profile: input.executionProfile,
    session: input.session,
    workspace: input.workspace,
    capabilities: input.capabilities,
    result: input.result,
    artifacts: input.artifacts,
    control_gates: input.controlGates,
    usage: input.usage,
    errors: input.errors,
    debug: input.debug
  };
}

async function persistTerminalExecution(input: {
  repository: BoStaffRepository;
  log: EventLog;
  response: ExecutionResponse;
  lifecycleStatus: Extract<ExecutionResponse["execution"]["status"], "completed" | "partial" | "failed" | "awaiting_control_gate">;
  terminalCommitInput: Omit<CommitTerminalExecutionInput, "response_snapshot" | "terminal_events">;
  failureEventMessage?: string;
}): Promise<{ response: ExecutionResponse }> {
  const persistedResponse = withPersistence(input.response, undefined);
  const persistedEvents = buildResolvedTerminalEvents(
    input.log,
    persistedResponse,
    input.lifecycleStatus,
    input.failureEventMessage
  );
  let finalResponse = persistedResponse;
  let publishedEvents = persistedEvents;
  try {
    await input.repository.commitTerminalExecution(
      applyPersistedResponse(input.terminalCommitInput, persistedResponse, persistedEvents)
    );
  } catch (error) {
    finalResponse = withPersistence(input.response, error);
    publishedEvents = buildResolvedTerminalEvents(
      input.log,
      finalResponse,
      input.lifecycleStatus,
      input.failureEventMessage
    );
    reportInternalError("execution.persist_terminal.commit", error, {
      execution_id: input.response.execution.execution_id,
      request_id: input.response.request_id,
      status: input.response.execution.status
    });
  }

  await publishTerminalEvents(input.log, publishedEvents, {
    request_id: input.response.request_id,
    execution_id: input.response.execution.execution_id
  });

  return {
    response: finalResponse
  };
}

async function persistImmediateExecutionResponse(input: {
  repository: BoStaffRepository;
  sessionlessExecutionRetentionMs: number;
  context: {
    executionId: string;
    requestId: string;
    request: NormalizedExecutionRequest;
    log: EventLog;
  };
  response: ExecutionResponse;
  terminalEvent: "execution.rejected" | "execution.failed";
  terminalEventMessage: string;
}): Promise<{ response: ExecutionResponse }> {
  const persistedResponse = withPersistence(input.response, undefined);
  const persistedEvents = buildImmediateTerminalEvents(
    input.context.log,
    persistedResponse,
    input.terminalEvent,
    input.terminalEventMessage
  );
  let finalResponse = persistedResponse;
  let publishedEvents = persistedEvents;
  try {
    await input.repository.commitTerminalExecution({
      execution_record: {
        execution_id: input.context.executionId,
        request_id: input.context.requestId,
        session_handle: null,
        backend: input.context.request.backend,
        status: persistedResponse.execution.status,
        degraded: persistedResponse.execution.degraded,
        retryable: persistedResponse.execution.retryable,
        started_at: persistedResponse.execution.started_at,
        updated_at: persistedResponse.execution.updated_at,
        completed_at: persistedResponse.execution.completed_at,
        request_snapshot: input.context.request,
        execution_profile: persistedResponse.execution_profile
      },
      response_snapshot: persistedResponse,
      usage: persistedResponse.usage,
      artifacts: persistedResponse.artifacts,
      control_gates: [...persistedResponse.control_gates.pending, ...persistedResponse.control_gates.resolved],
      capability_outcomes: persistedResponse.capabilities,
      workspace_record: {
        execution_id: input.context.executionId,
        session_handle: null,
        summary: persistedResponse.workspace
      },
      terminal_events: persistedEvents
    });
  } catch (error) {
    finalResponse = withPersistence(input.response, error);
    publishedEvents = buildImmediateTerminalEvents(
      input.context.log,
      finalResponse,
      input.terminalEvent,
      input.terminalEventMessage
    );
    reportInternalError("execution.emit_immediate_response.commit", error, {
      execution_id: input.context.executionId,
      request_id: input.context.requestId,
      status: input.response.execution.status
    });
  }

  if (input.response.execution.terminal) {
    try {
      await input.repository.pruneSessionlessTerminalExecutions(pruneBeforeIso(input.sessionlessExecutionRetentionMs));
    } catch (error) {
      reportInternalError("execution.emit_immediate_response.prune", error, {
        execution_id: input.context.executionId,
        request_id: input.context.requestId
      });
    }
  }

  await publishTerminalEvents(input.context.log, publishedEvents, {
    request_id: input.context.requestId,
    execution_id: input.context.executionId
  });

  return {
    response: finalResponse
  };
}

function withPersistence(response: ExecutionResponse, persistenceError: unknown): ExecutionResponse {
  return {
    ...response,
    persistence: persistenceError
      ? buildPersistenceSummary(
        "failed",
        persistenceError instanceof Error ? persistenceError.message : String(persistenceError)
      )
      : buildPersistenceSummary("persisted")
  };
}

function applyPersistedResponse(
  input: Omit<CommitTerminalExecutionInput, "response_snapshot" | "terminal_events">,
  response: ExecutionResponse,
  terminalEvents: BoStaffEvent[]
): CommitTerminalExecutionInput {
  return {
    ...input,
    execution_record: {
      ...input.execution_record,
      response_snapshot: response
    },
    response_snapshot: response,
    terminal_events: terminalEvents
  };
}

function buildResolvedTerminalEvents(
  log: EventLog,
  response: ExecutionResponse,
  status: Extract<ExecutionResponse["execution"]["status"], "completed" | "partial" | "failed" | "awaiting_control_gate">,
  failureMessage?: string
): BoStaffEvent[] {
  return [
    buildLifecycleTerminalEvent({
      log,
      status,
      message: status === "failed" ? failureMessage : undefined
    }),
    buildResponseEvent(log, response)
  ];
}

function buildImmediateTerminalEvents(
  log: EventLog,
  response: ExecutionResponse,
  terminalEvent: "execution.rejected" | "execution.failed",
  message: string
): BoStaffEvent[] {
  return [
    log.build(terminalEvent, { message }),
    buildResponseEvent(log, response)
  ];
}

async function publishTerminalEvents(
  log: EventLog,
  events: BoStaffEvent[],
  context: {
    request_id: string;
    execution_id: string | null;
  }
): Promise<void> {
  for (const event of events) {
    try {
      await log.record(event);
    } catch (error) {
      reportInternalError("execution.publish_terminal_event", error, {
        ...context,
        event: event.event
      });
    }
  }
}

async function cleanupWorkspace(
  workspaceManager: WorkspaceManager,
  workspace: WorkspaceRuntime,
  context: {
    execution_id: string;
    request_id: string;
    phase: "resolved" | "failure";
  }
): Promise<void> {
  try {
    await workspaceManager.cleanup(workspace);
  } catch (error) {
    reportInternalError("execution.cleanup_workspace", error, context);
  }
}
