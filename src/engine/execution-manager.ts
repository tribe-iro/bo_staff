import { DEFAULT_MAX_CONCURRENT_EXECUTIONS } from "../config/defaults.ts";
import { RequestResolutionError } from "../errors.ts";
import type { BackendName, ExecutionProfileOutcome, HealthResponse, HealthStatus, NormalizedExecutionRequest, UsageSummary } from "../types.ts";
import type { ErrorCategory, ErrorCode } from "../errors/taxonomy.ts";
import type { CliAgentAdapter } from "../adapters/types.ts";
import type { WorkspaceRuntime } from "./workspace-manager.ts";
import type { PromptEnvelope } from "./prompt-envelope.ts";
import type { ExecutionLease } from "../core/lease.ts";
import type { EphemeralExecutionState } from "./types.ts";
import type { ExecutionStatus } from "../core/execution.ts";
import { EnvelopeBuilder } from "../bomcp/envelope-builder.ts";
import { ControllerStream, type StreamWriter } from "../bomcp/controller-stream.ts";
import { buildLease, LeaseValidator } from "../bomcp/lease.ts";
import { BomcpToolHandler } from "../bomcp/tool-handler.ts";
import { createIpcServer, type IpcServer } from "../bomcp/ipc-channel.ts";
import { createEphemeralState } from "./execution-state.ts";
import { buildExecutionPrompt } from "./prompt.ts";
import { WorkspaceManager } from "./workspace-manager.ts";
import { ExecutionAdmissionController } from "./execution-admission.ts";
import { generateHandle } from "../utils.ts";
import { collectProviderResult, type ProviderResult } from "./provider-collector.ts";
import { finalizeExecution } from "./execution-finalization.ts";
import * as path from "node:path";
import { reportInternalError } from "../internal-reporting.ts";

export interface ExecutionAuditRecord {
  _type: "execution.audit";
  timestamp: string;
  execution_id: string;
  request_id: string;
  backend: string;
  status: ExecutionStatus;
  duration_ms: number;
  usage?: UsageSummary;
  error?: { code: ErrorCode; category: ErrorCategory };
}

import { DEFAULT_HEARTBEAT_INTERVAL_MS } from "../config/defaults.ts";

interface ActiveExecution {
  state: EphemeralExecutionState;
  abortController: AbortController;
  stream: ControllerStream;
  ipcServer: IpcServer;
  heartbeatTimer?: ReturnType<typeof setInterval>;
}

export class ExecutionManager {
  private readonly adapters: Map<BackendName, CliAgentAdapter>;
  private readonly workspaceManager: WorkspaceManager;
  private readonly admission: ExecutionAdmissionController;
  private readonly activeExecutions = new Map<string, ActiveExecution>();
  // Synchronously-held reservation set for caller-supplied execution ids, so two concurrent
  // requests with the same idempotency key can't both pass the dedup check before either
  // registers in activeExecutions (at-most-once).
  private readonly reservedExecutionIds = new Set<string>();
  private readonly dataDir: string;

  constructor(input: {
    adapters: CliAgentAdapter[];
    dataDir: string;
    maxConcurrentExecutions?: number;
    workspaceManager?: WorkspaceManager;
    admissionController?: ExecutionAdmissionController;
  }) {
    this.adapters = new Map(input.adapters.map((a) => [a.backend, a]));
    this.workspaceManager = input.workspaceManager ?? new WorkspaceManager(input.dataDir);
    this.admission = input.admissionController ?? new ExecutionAdmissionController(
      input.maxConcurrentExecutions ?? DEFAULT_MAX_CONCURRENT_EXECUTIONS,
    );
    this.dataDir = input.dataDir;
  }

  async execute(input: {
    requestId: string;
    request: NormalizedExecutionRequest;
    lease?: { allowed_tools?: string[]; timeout_seconds?: number };
    streamWriter: StreamWriter;
    signal: AbortSignal;
  }): Promise<void> {
    // Caller-supplied execution_id is an idempotency key + cancellation handle the caller
    // already knows (fixes sync-cancel: no need to wait for the buffered response to learn it).
    const executionId = input.request.execution_id ?? generateHandle("exec");
    const lease = buildLease({
      executionId,
      allowedTools: input.lease?.allowed_tools,
      timeoutSeconds: input.lease?.timeout_seconds,
    });
    const state = createEphemeralState(executionId, input.request.backend, lease);
    const envelopeBuilder = new EnvelopeBuilder(executionId);
    const stream = new ControllerStream(input.streamWriter, envelopeBuilder);

    // At-most-once: reject a duplicate id that's already in flight. The check + reserve are
    // synchronous (no await between), so concurrent same-key requests can't both pass.
    if (this.activeExecutions.has(executionId) || this.reservedExecutionIds.has(executionId)) {
      await stream.emitRuntime("system.error", {
        code: "validation_failed",
        message: `execution_id "${executionId}" is already in flight`,
      });
      return;
    }
    this.reservedExecutionIds.add(executionId);

    // Admission
    if (!this.admission.tryAcquire()) {
      await stream.emitRuntime("system.error", {
        code: this.admission.isDraining() ? "gateway_draining" : "gateway_busy",
        message: "bo_staff cannot accept new executions right now.",
      });
      this.reservedExecutionIds.delete(executionId);
      return;
    }

    try {
      await this.executeInner(input, executionId, lease, state, stream);
    } finally {
      this.emitAuditRecord(state, input.requestId);
      await this.teardown(executionId);
      this.admission.release();
      this.reservedExecutionIds.delete(executionId);
    }
  }

  private async executeInner(
    input: {
      requestId: string;
      request: NormalizedExecutionRequest;
      signal: AbortSignal;
    },
    executionId: string,
    lease: ExecutionLease,
    state: EphemeralExecutionState,
    stream: ControllerStream,
  ): Promise<void> {
    // Resolve execution context
    let executionProfile: ExecutionProfileOutcome;
    let workspace: WorkspaceRuntime | undefined;
    let prompt: PromptEnvelope;
    let adapter: CliAgentAdapter;

    try {
      executionProfile = resolveExecutionProfile(input.request);
      const a = this.adapters.get(input.request.backend);
      if (!a) throw new RequestResolutionError(`No adapter for backend ${input.request.backend}`, "unknown_backend", 500);
      adapter = a;
      workspace = await this.workspaceManager.prepare({
        request: input.request,
        runtimeHandle: executionId,
      });
      prompt = await buildExecutionPrompt({ request: input.request });
    } catch (err) {
      const msg = err instanceof RequestResolutionError ? err.message : String(err);
      await stream.emitRuntime("system.error", {
        code: err instanceof RequestResolutionError ? err.code : "internal_error",
        message: msg,
      });
      await stream.emitRuntime("execution.failed", {
        execution_id: executionId,
        status: "failed",
        message: msg,
      });
      if (workspace) {
        await this.cleanupWorkspace(workspace);
      }
      return;
    }

    // Start IPC server for bomcp-server
    const socketPath = path.join(this.dataDir, "ipc", `${executionId}.sock`);
    const ipcServer = createIpcServer(socketPath);
    const abortController = new AbortController();
    const toolHandler = new BomcpToolHandler(
      stream,
      state,
      abortController.signal,
      workspace.runtime_working_directory
    );

    await ipcServer.start((req) => toolHandler.handle(req));

    // Register active execution
    const active: ActiveExecution = {
      state,
      abortController,
      stream,
      ipcServer,
    };
    this.activeExecutions.set(executionId, active);

    // Abort on caller disconnect
    const onControllerAbort = () => abortController.abort("controller_disconnected");
    input.signal.addEventListener("abort", onControllerAbort, { once: true });

    // Emit execution.started
    state.status = "running";
    const started = await stream.emitRuntime("execution.started", {
      backend: input.request.backend,
      execution_id: executionId,
    });
    if (!started.delivered) {
      reportInternalError("execution.started.dropped", new Error("execution.started was not delivered"), {
        execution_id: executionId,
      });
    }

    // Start heartbeat
    const heartbeatIntervalMs = input.request.runtime.heartbeat_interval_ms ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    active.heartbeatTimer = setInterval(() => {
      stream.emitRuntime("progress.heartbeat", {}).catch((err) => {
        reportInternalError("execution.heartbeat.emit", err, { execution_id: executionId });
      });
    }, heartbeatIntervalMs);

    // Lease expiry timer
    let leaseTimer: ReturnType<typeof setTimeout> | undefined;
    if (lease.timeout_seconds) {
      leaseTimer = setTimeout(() => {
        stream.emitRuntime("system.lease_expired", { execution_id: executionId })
          .then(({ delivered }) => {
            if (!delivered) {
              reportInternalError("execution.lease_expired.dropped", new Error("system.lease_expired was not delivered"), {
                execution_id: executionId,
              });
            }
          })
          .catch((err) => {
            reportInternalError("execution.lease_expired.emit", err, { execution_id: executionId });
          });
        state.status = "cancelled";
        abortController.abort("lease_expired");
      }, lease.timeout_seconds * 1000);
    }

    // Collect provider events
    let providerResult: ProviderResult;
    try {
      // Build bomcp-server config for adapter injection
      const bomcpServerConfig = lease.allowed_tools.length > 0 ? {
        command: process.execPath,
        args: [new URL("../bomcp/server.ts", import.meta.url).pathname],
        env: {
          BO_MCP_EXECUTION_ID: executionId,
          BO_MCP_IPC_ADDRESS: socketPath,
        },
      } : undefined;

      providerResult = await collectProviderResult({
        adapter,
        executionId,
        requestId: input.requestId,
        request: input.request,
        executionProfile,
        workspace,
        prompt,
        signal: abortController.signal,
        abortController,
        stream,
        state,
        bomcpServerConfig,
      });
    } catch (err) {
      providerResult = {
        failure: {
          command: adapter.backend,
          reason: "aborted",
          exit_code: null,
          stdout: "",
          stderr: String(err),
        },
      };
    } finally {
      input.signal.removeEventListener("abort", onControllerAbort);
      if (leaseTimer) clearTimeout(leaseTimer);
    }

    // Check if cancelled via abort
    if (abortController.signal.aborted) {
      const reason = abortController.signal.reason ?? "cancelled";
      state.status = "cancelled";
      const cancelled = await stream.emitRuntime("execution.cancelled", {
        execution_id: executionId,
        reason: String(reason),
      });
      if (!cancelled.delivered) {
        reportInternalError("execution.cancelled.dropped", new Error("execution.cancelled was not delivered"), {
          execution_id: executionId,
          reason: String(reason),
        });
      }
      await this.cleanupWorkspace(workspace);
      return;
    }

    // Finalize
    await finalizeExecution({
      stream,
      workspaceManager: this.workspaceManager,
      state,
      workspace,
      request: input.request,
      providerResult,
    });
  }

  async cancelExecution(
    executionId: string,
    reason: string = "cancel_request",
  ): Promise<"accepted" | "not_found"> {
    const active = this.activeExecutions.get(executionId);
    if (!active) return "not_found";
    active.state.status = "cancelled";
    active.abortController.abort(reason);
    return "accepted";
  }

  getActiveExecution(executionId: string): EphemeralExecutionState | undefined {
    return this.activeExecutions.get(executionId)?.state;
  }

  healthCheck(): HealthResponse {
    const load = this.admission.currentLoad();
    let status: HealthStatus = "accepting";
    if (load.draining) {
      status = "degraded";
    } else if (load.active >= load.max) {
      status = "saturated";
    } else {
      for (const active of this.activeExecutions.values()) {
        const validator = new LeaseValidator(active.state.lease);
        if (validator.isExpired()) {
          status = "degraded";
          break;
        }
      }
    }
    return {
      status,
      executions: {
        active: load.active,
        max: load.max,
        draining: load.draining,
      },
    };
  }

  async shutdown(): Promise<void> {
    for (const [id, active] of this.activeExecutions) {
      active.abortController.abort("gateway_shutdown");
    }
    await this.admission.drain();
  }

  // --- Internal ---

  private async teardown(executionId: string): Promise<void> {
    const active = this.activeExecutions.get(executionId);
    if (!active) return;
    if (active.heartbeatTimer) clearInterval(active.heartbeatTimer);
    try {
      await active.ipcServer.stop();
    } catch (err) {
      reportInternalError("execution.teardown.ipc_stop", err, { execution_id: executionId });
    }
    active.stream.close();
    this.activeExecutions.delete(executionId);
  }

  private emitAuditRecord(state: EphemeralExecutionState, requestId: string): void {
    const durationMs = Date.now() - new Date(state.started_at).getTime();
    const record: ExecutionAuditRecord = {
      _type: "execution.audit",
      timestamp: new Date().toISOString(),
      execution_id: state.execution_id,
      request_id: requestId,
      backend: state.backend,
      status: state.status,
      duration_ms: durationMs,
    };
    try {
      process.stderr.write(JSON.stringify(record) + "\n");
    } catch {
      // best-effort — stderr may be closed
    }
  }

  private async cleanupWorkspace(workspace: WorkspaceRuntime): Promise<void> {
    try {
      await this.workspaceManager.cleanup(workspace);
    } catch { /* best-effort */ }
  }
}

function resolveExecutionProfile(request: NormalizedExecutionRequest): ExecutionProfileOutcome {
  return {
    model: request.execution_profile.model,
    reasoning_effort: request.execution_profile.reasoning_effort,
  };
}
