import { isExecutableOnPath, nowIso } from "./utils.ts";
import { asRecord } from "./utils.ts";
import { normalizeAndValidateRequest } from "./validation.ts";
import { ExecutionManager } from "./engine/execution-manager.ts";
import { deleteSessionWithResources } from "./gateway/session-lifecycle.ts";
import type {
  BoStaffEvent,
  ExecutionResponse,
  SessionListResponse,
  SessionRecordSummary
} from "./types.ts";
import type { BoStaffRepository } from "./persistence/types.ts";
import {
  buildValidationRejectionResponse,
  clampSessionPageLimit,
  decodeSessionCursor,
  snapshotToExecutionResponse,
  toSessionRecordSummary,
  toSessionListResponse
} from "./gateway/response.ts";

export interface BoStaffOptions {
  dataDir: string;
  repository: BoStaffRepository;
  executionManager: ExecutionManager;
  onShutdown?: () => Promise<void>;
}

export class BoStaff {
  private readonly options: BoStaffOptions;

  constructor(options: BoStaffOptions) {
    this.options = options;
  }

  async execute(
    rawRequest: unknown,
    requestId: string,
    options?: {
      onEvent?: (event: BoStaffEvent) => Promise<void> | void;
      onExecutionCreated?: (executionId: string) => Promise<void> | void;
    }
  ): Promise<{ httpStatus: number; body: ExecutionResponse; events: import("./types.ts").BoStaffEvent[] }> {
    const validation = await normalizeAndValidateRequest(rawRequest);
    if (!validation.ok) {
      const now = nowIso();
      const validationMessage = validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ");
      const response = buildValidationRejectionResponse({
        requestId,
        occurredAt: now,
        message: validationMessage,
        durabilityKind: asRecord(rawRequest)?.session && asRecord(asRecord(rawRequest)?.session)?.mode === "ephemeral"
          ? "ephemeral"
          : "persistent"
      });
      const rejectionEvent = {
        event: "execution.rejected" as const,
        request_id: requestId,
        execution_id: null,
        emitted_at: now,
        data: {
          reason: validationMessage
        }
      };
      const responseEvent = {
        event: "execution.snapshot" as const,
        request_id: requestId,
        execution_id: null,
        emitted_at: now,
        data: {
          response
        }
      };
      await options?.onEvent?.(rejectionEvent);
      await options?.onEvent?.(responseEvent);
      return {
        httpStatus: 400,
        body: response,
        events: [rejectionEvent, responseEvent]
      };
    }

    const result = await this.options.executionManager.execute({
      requestId,
      request: validation.value,
      onEvent: options?.onEvent,
      onExecutionCreated: options?.onExecutionCreated
    });
    return {
      httpStatus: result.httpStatus,
      body: result.response,
      events: result.events
    };
  }

  async health(): Promise<unknown> {
    const sessionCount = await this.options.repository.countSessions();
    return {
      ok: true,
      api_version: "v0.1",
      data_dir: this.options.dataDir,
      runtimes: {
        codex: await isExecutableOnPath("codex"),
        claude: await isExecutableOnPath("claude")
      },
      session_count: sessionCount
    };
  }

  async listSessions(input?: { limit?: number; cursor?: string }): Promise<SessionListResponse> {
    const limit = clampSessionPageLimit(input?.limit);
    const cursor = decodeSessionCursor(input?.cursor);
    const page = await this.options.repository.listSessionsPage({
      limit,
      after: cursor
    });
    return toSessionListResponse(page);
  }

  async getSession(handle: string): Promise<SessionRecordSummary | undefined> {
    const session = await this.options.repository.getSession(handle);
    return session ? toSessionRecordSummary(session) : undefined;
  }

  async getExecution(executionId: string): Promise<ExecutionResponse | undefined> {
    const execution = await this.options.repository.getExecution(executionId);
    return execution ? snapshotToExecutionResponse(execution) : undefined;
  }

  async getExecutionEvents(executionId: string): Promise<BoStaffEvent[]> {
    return this.options.repository.getExecutionEvents(executionId);
  }

  async cancelExecution(executionId: string): Promise<"accepted" | "not_found" | "already_terminal" | "not_cancellable"> {
    return this.options.executionManager.cancelExecution(executionId);
  }

  async deleteSession(handle: string): Promise<boolean> {
    return deleteSessionWithResources({
      dataDir: this.options.dataDir,
      repository: this.options.repository,
      handle
    });
  }

  async shutdown(): Promise<void> {
    await this.options.executionManager.shutdown();
    await this.options.repository.close();
    await this.options.onShutdown?.();
  }
}
