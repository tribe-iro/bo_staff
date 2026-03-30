import { normalizeLayeredRequest } from "./api/normalize.ts";
import { ExecutionManager } from "./engine/execution-manager.ts";
import type { BomcpEnvelope } from "./bomcp/types.ts";
import type { StreamWriter } from "./bomcp/controller-stream.ts";
import type { HealthResponse, NormalizedExecutionRequest } from "./types.ts";
import { generateHandle } from "./utils.ts";

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
    const normalized = await normalizeLayeredRequest(input.rawRequest);

    if (!normalized.ok) {
      const envelope: BomcpEnvelope = {
        message_id: generateHandle("msg"),
        kind: "system.error",
        sequence: 1,
        timestamp: new Date().toISOString(),
        sender: { type: "runtime", id: "runtime" },
        payload: {
          code: "validation_failed",
          message: normalized.issues.map((e) => e.message).join("; "),
          issues: normalized.issues,
        },
      };
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

  async health(): Promise<HealthResponse> {
    return { status: "ok" };
  }

  async shutdown(): Promise<void> {
    await this.executionManager.shutdown();
  }
}
