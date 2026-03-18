import { resolveExecutionProfile } from "../config/execution-profiles.ts";
import {
  DEFAULT_MAX_CONCURRENT_EXECUTIONS,
  DEFAULT_SESSIONLESS_EXECUTION_RETENTION_MS
} from "../config/defaults.ts";
import { RequestResolutionError } from "../errors.ts";
import type { BackendName, ExecutionError, ExecutionResponse, NormalizedExecutionRequest } from "../types.ts";
import type { BackendAdapter } from "../adapters/types.ts";
import type { SessionResolution } from "./session-manager.ts";
import type { WorkspaceRuntime } from "./workspace-manager.ts";
import type { BoStaffRepository, ExecutionRecord } from "../persistence/types.ts";
import { EventLog } from "./event-log.ts";
import { buildExecutionPrompt } from "./prompt.ts";
import { SessionManager } from "./session-manager.ts";
import { WorkspaceManager } from "./workspace-manager.ts";
import { resolveGuarantees } from "./guarantee-resolution.ts";
import { buildRejectedExecutionSummary } from "../execution-summary.ts";
import { generateHandle, nowIso } from "../utils.ts";
import { ExecutionAdmissionController } from "./execution-admission.ts";
import { SessionLeaseManager } from "./session-leases.ts";
import { isTerminalStatus } from "../core/index.ts";
import {
  buildPersistenceSummary,
  buildRejectedWorkspaceSummary,
  buildWorkspaceRecord,
  createProviderAccumulation,
  formatExecutionError,
  resolveExecutionProfileSafe,
  type ProviderAccumulation
} from "./execution-state.ts";
import { recordExecutionEvent } from "./event-projection.ts";
import {
  emitImmediateExecutionResponse,
  finalizeResolvedExecution,
  finalizeRuntimeFailure
} from "./execution-finalization.ts";
import { collectProviderResult } from "./provider-collector.ts";

interface ExecutionRunContext {
  executionId: string;
  requestId: string;
  request: NormalizedExecutionRequest;
  log: EventLog;
  guaranteeResolution: ReturnType<typeof resolveGuarantees>;
}

interface ResolvedExecutionContext extends ExecutionRunContext {
  executionProfile: Awaited<ReturnType<typeof resolveExecutionProfile>>;
  session: SessionResolution;
  workspace: WorkspaceRuntime;
  adapter: BackendAdapter;
  prompt: string;
}

export class ExecutionManager {
  private readonly adapters: Map<BackendName, BackendAdapter>;
  private readonly sessionManager: SessionManager;
  private readonly workspaceManager: WorkspaceManager;
  private readonly repository: BoStaffRepository;
  private readonly profilesFile?: string;
  private readonly admission: ExecutionAdmissionController;
  private readonly sessionLeases = new SessionLeaseManager();
  private readonly activeExecutionControllers = new Map<string, AbortController>();
  private readonly sessionlessExecutionRetentionMs: number;

  constructor(input: {
    adapters: BackendAdapter[];
    repository: BoStaffRepository;
    dataDir: string;
    profilesFile?: string;
    maxConcurrentExecutions?: number;
    sessionlessExecutionRetentionMs?: number;
  }) {
    this.adapters = new Map(input.adapters.map((adapter) => [adapter.backend, adapter]));
    this.sessionManager = new SessionManager(input.repository);
    this.workspaceManager = new WorkspaceManager(input.dataDir);
    this.repository = input.repository;
    this.profilesFile = input.profilesFile;
    this.admission = new ExecutionAdmissionController(input.maxConcurrentExecutions ?? DEFAULT_MAX_CONCURRENT_EXECUTIONS);
    this.sessionlessExecutionRetentionMs = input.sessionlessExecutionRetentionMs ?? DEFAULT_SESSIONLESS_EXECUTION_RETENTION_MS;
  }

  async execute(input: {
    requestId: string;
    request: NormalizedExecutionRequest;
    onEvent?: (event: import("../types.ts").BoStaffEvent) => Promise<void> | void;
    onExecutionCreated?: (executionId: string) => Promise<void> | void;
  }): Promise<{ httpStatus: number; response: ExecutionResponse; events: ReturnType<EventLog["list"]> }> {
    const executionId = generateHandle("exec");
    const log = new EventLog(input.requestId, executionId, input.onEvent);
    await input.onExecutionCreated?.(executionId);
    const runContext: ExecutionRunContext = {
      executionId,
      requestId: input.requestId,
      request: input.request,
      log,
      guaranteeResolution: resolveGuarantees({ request: input.request })
    };

    if (!this.admission.tryAcquire()) {
      return this.emitImmediateRejection(runContext, {
        httpStatus: 503,
        error: {
          code: this.admission.isDraining() ? "gateway_draining" : "gateway_busy",
          message: this.admission.isDraining()
            ? "bo_staff is draining and not accepting new executions."
            : "bo_staff has reached the maximum number of concurrent executions."
        }
      });
    }

    const leasedSessionHandle = input.request.session.mode === "continue" || input.request.session.mode === "fork"
      ? input.request.session.handle
      : null;
    if (!this.sessionLeases.tryAcquire(leasedSessionHandle)) {
      this.admission.release();
      return this.emitImmediateRejection(runContext, {
        httpStatus: 409,
        error: {
          code: "session_busy",
          message: `Session handle is already executing: ${leasedSessionHandle}`
        }
      });
    }

    try {
      const resolved = await this.resolveExecutionContext(runContext);
      if (!resolved.ok) {
        const immediate = await emitImmediateExecutionResponse({
          repository: this.repository,
          sessionlessExecutionRetentionMs: this.sessionlessExecutionRetentionMs,
          context: runContext,
          httpStatus: resolved.httpStatus,
          response: resolved.response,
          terminalEvent: "execution.rejected"
        });
        return {
          httpStatus: immediate.httpStatus,
          response: immediate.response,
          events: runContext.log.list()
        };
      }

      return await this.executeResolved(resolved.value);
    } finally {
      this.sessionLeases.release(leasedSessionHandle);
      this.admission.release();
    }
  }

  async shutdown(): Promise<void> {
    for (const controller of this.activeExecutionControllers.values()) {
      controller.abort();
    }
    await this.admission.drain();
  }

  async cancelExecution(executionId: string): Promise<"accepted" | "not_found" | "already_terminal" | "not_cancellable"> {
    const controller = this.activeExecutionControllers.get(executionId);
    if (controller) {
      controller.abort();
      return "accepted";
    }
    const execution = await this.repository.getExecution(executionId);
    if (!execution) {
      return "not_found";
    }
    if (execution.execution.completed_at || isTerminalStatus(execution.execution.status)) {
      return "already_terminal";
    }
    return "not_cancellable";
  }

  private async resolveExecutionContext(
    input: ExecutionRunContext
  ): Promise<
    | { ok: true; value: ResolvedExecutionContext }
    | { ok: false; httpStatus: number; response: ExecutionResponse }
  > {
    try {
      const executionProfile = await resolveExecutionProfile({ request: input.request, profilesFile: this.profilesFile });
      const session = await this.sessionManager.resolve({
        request: input.request,
        backend: input.request.backend,
        sourceRoot: input.request.workspace.source_root
      });
      const workspace = await this.workspaceManager.prepare({
        request: input.request,
        runtimeHandle: session.internal_handle
      });
      const prompt = await buildExecutionPrompt({
        request: input.request,
        managedContext: session.continuation_capsule
      });
      const adapter = this.adapters.get(input.request.backend);
      if (!adapter) {
        throw new RequestResolutionError(`No backend adapter registered for ${input.request.backend}`, "unknown_backend", 500);
      }
      return {
        ok: true,
        value: {
          ...input,
          executionProfile,
          session,
          workspace,
          adapter,
          prompt
        }
      };
    } catch (error) {
      return {
        ok: false,
        httpStatus: error instanceof RequestResolutionError ? error.httpStatus : 500,
        response: await this.buildRejectionResponse(
          input,
          formatExecutionError(error),
          "Execution rejected during request resolution."
        )
      };
    }
  }

  private async executeResolved(
    context: ResolvedExecutionContext
  ): Promise<{ httpStatus: number; response: ExecutionResponse; events: ReturnType<EventLog["list"]> }> {
    const startedAt = nowIso();
    const runningRecord: ExecutionRecord = {
      execution_id: context.executionId,
      request_id: context.requestId,
      session_handle: context.session.record ? context.session.internal_handle : null,
      backend: context.request.backend,
      status: "running",
      degraded: false,
      retryable: false,
      started_at: startedAt,
      updated_at: startedAt,
      request_snapshot: context.request,
      execution_profile: context.executionProfile
    };

    const abortController = new AbortController();
    const provider = createProviderAccumulation(context.session);
    this.activeExecutionControllers.set(context.executionId, abortController);
    try {
      await this.repository.initializeExecution({
        session_record: context.session.persist_on_initialize ? context.session.record : undefined,
        execution_record: runningRecord,
        capability_outcomes: context.guaranteeResolution.outcomes,
        workspace_record: buildWorkspaceRecord(context.executionId, context.session, context.workspace)
      });
      await this.recordExecutionStart(context);
      await collectProviderResult({
        adapter: context.adapter,
        repository: this.repository,
        executionId: context.executionId,
        requestId: context.requestId,
        request: context.request,
        executionProfile: context.executionProfile,
        session: context.session,
        workspace: context.workspace,
        prompt: context.prompt,
        signal: abortController.signal,
        log: context.log,
        accumulation: provider
      });
      const finalized = await finalizeResolvedExecution({
        repository: this.repository,
        workspaceManager: this.workspaceManager,
        context,
        runningRecord,
        startedAt,
        provider
      });
      return {
        httpStatus: finalized.httpStatus,
        response: finalized.response,
        events: context.log.list()
      };
    } catch (error) {
      const failed = await finalizeRuntimeFailure({
        repository: this.repository,
        workspaceManager: this.workspaceManager,
        context,
        runningRecord,
        startedAt,
        error,
        provider
      });
      return {
        httpStatus: failed.httpStatus,
        response: failed.response,
        events: context.log.list()
      };
    } finally {
      this.activeExecutionControllers.delete(context.executionId);
    }
  }

  private async emitImmediateRejection(
    context: ExecutionRunContext,
    input: {
      httpStatus: number;
      error: ExecutionError;
    }
  ): Promise<{ httpStatus: number; response: ExecutionResponse; events: ReturnType<EventLog["list"]> }> {
    const response = await this.buildRejectionResponse(context, input.error);
    const immediate = await emitImmediateExecutionResponse({
      repository: this.repository,
      sessionlessExecutionRetentionMs: this.sessionlessExecutionRetentionMs,
      context,
      httpStatus: input.httpStatus,
      response,
      terminalEvent: "execution.rejected"
    });
    return {
      httpStatus: immediate.httpStatus,
      response: immediate.response,
      events: context.log.list()
    };
  }

  private async recordExecutionStart(context: ResolvedExecutionContext): Promise<void> {
    await recordExecutionEvent({
      repository: this.repository,
      log: context.log,
      executionId: context.executionId,
      event: "execution.accepted",
      data: { backend: context.request.backend }
    });
    await recordExecutionEvent({
      repository: this.repository,
      log: context.log,
      executionId: context.executionId,
      event: "execution.started",
      data: {
        backend: context.request.backend,
        session_handle: context.session.public_handle
      }
    });
    await recordExecutionEvent({
      repository: this.repository,
      log: context.log,
      executionId: context.executionId,
      event: "execution.progress_initialized",
      data: {
        topology: context.workspace.topology
      }
    });
  }

  private async buildRejectionResponse(
    context: ExecutionRunContext,
    error: ExecutionError,
    summary = "Execution rejected before backend dispatch."
  ): Promise<ExecutionResponse> {
    return {
      api_version: "v0.1",
      request_id: context.requestId,
      execution: buildRejectedExecutionSummary(context.executionId, nowIso()),
      persistence: buildPersistenceSummary("not_attempted"),
      execution_profile: await resolveExecutionProfileSafe(context.request, this.profilesFile),
      session: {
        handle: context.request.session.handle,
        continuity_kind: "none",
        durability_kind: context.request.session.mode === "ephemeral" ? "ephemeral" : "persistent"
      },
      workspace: buildRejectedWorkspaceSummary(context.request),
      capabilities: context.guaranteeResolution.outcomes,
      result: {
        summary,
        payload: {},
        pending_items: []
      },
      artifacts: [],
      control_gates: { pending: [], resolved: [] },
      errors: [error],
      debug: {
        capability_diagnostics: context.guaranteeResolution.diagnostics
      }
    };
  }
}
