import { normalizeLayeredRequest } from "./api/normalize.ts";
import { ExecutionManager } from "./engine/execution-manager.ts";
import type { BomcpEnvelope } from "./events/types.ts";
import type { StreamWriter } from "./bomcp/controller-stream.ts";
import type { HealthResponse, NormalizedExecutionRequest } from "./types.ts";
import { buildRuntimeErrorEnvelope } from "./runtime/error-envelope.ts";
import { generateHandle } from "./utils.ts";
import { formatValidationIssueSummary } from "./validation/summary.ts";

export class BoStaff {
  private readonly executionManager: ExecutionManager;

  constructor(input: { executionManager: ExecutionManager }) {
    this.executionManager = input.executionManager;
  }

  async execute(input: {
    rawRequest: unknown;
    streamWriter: StreamWriter;
    signal: AbortSignal;
  }): Promise<void> {
    const normalized = await this.prepareExecution(input.rawRequest);

    if (!normalized.ok) {
      const envelope: BomcpEnvelope = buildRuntimeErrorEnvelope({
        code: "validation_failed",
        message: formatValidationIssueSummary(normalized.issues),
        issues: normalized.issues,
      }, { message_id: generateHandle("msg"), sequence: 1 });
      await input.streamWriter(envelope);
      return;
    }

    await this.executeNormalized({
      request: normalized.request,
      lease: normalized.lease,
      streamWriter: input.streamWriter,
      signal: input.signal,
    });
  }

  async prepareExecution(rawRequest: unknown) {
    return normalizeLayeredRequest(rawRequest);
  }

  async executeNormalized(input: {
    request: NormalizedExecutionRequest;
    lease?: { allowed_tools?: string[]; timeout_seconds?: number };
    streamWriter: StreamWriter;
    signal: AbortSignal;
  }): Promise<void> {
    const requestId = generateHandle("req");
    await this.executionManager.execute({
      requestId,
      request: input.request,
      lease: input.lease,
      streamWriter: input.streamWriter,
      signal: input.signal,
    });
  }

  async cancelExecution(executionId: string, reason?: string): Promise<"accepted" | "not_found"> {
    return this.executionManager.cancelExecution(executionId, reason);
  }

  getActiveExecution(executionId: string) {
    return this.executionManager.getActiveExecution(executionId);
  }

  health(): HealthResponse {
    return this.executionManager.healthCheck();
  }

  async shutdown(): Promise<void> {
    await this.executionManager.shutdown();
  }
}
