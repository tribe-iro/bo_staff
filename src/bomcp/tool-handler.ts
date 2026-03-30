import * as path from "node:path";
import { access } from "node:fs/promises";
import type {
  ControlHandoffParams,
  ArtifactRegisterParams,
  ArtifactRequireParams,
  ProgressUpdateParams,
  EphemeralExecutionState,
  HandoffAckResponse,
  IpcToolCallRequest,
  IpcToolCallResponse,
  ArtifactRegisterResponse,
  ArtifactRequireResponse,
  ProgressAckResponse,
} from "./types.ts";
import type { ControllerStream } from "./controller-stream.ts";
import { LeaseValidator } from "./lease.ts";
import {
  parseArtifactRegisterParams,
  parseArtifactRequireParams,
  parseControlHandoffParams,
  parseProgressUpdateParams,
  ToolParameterError,
} from "./params.ts";
import { resolveContainedRealPath } from "../workspace/scope.ts";

class ToolExecutionStateError extends Error {
  readonly code: "execution_cancelled" | "execution_not_active";

  constructor(code: "execution_cancelled" | "execution_not_active", message: string) {
    super(message);
    this.code = code;
  }
}

export class BomcpToolHandler {
  private readonly leaseValidator: LeaseValidator;

  private readonly stream: ControllerStream;
  private readonly state: EphemeralExecutionState;
  private readonly artifactRoot?: string;
  private readonly signal: AbortSignal;
  private artifactCounter = 0;

  constructor(
    stream: ControllerStream,
    state: EphemeralExecutionState,
    signal: AbortSignal,
    artifactRoot?: string,
  ) {
    this.stream = stream;
    this.state = state;
    this.signal = signal;
    this.artifactRoot = artifactRoot;
    this.leaseValidator = new LeaseValidator(state.lease);
  }

  async handle(req: IpcToolCallRequest): Promise<IpcToolCallResponse> {
    const cached = this.state.processed_request_ids.get(req.request_id);
    if (cached !== undefined) {
      return { type: "tool_response", request_id: req.request_id, result: cached };
    }

    const check = this.leaseValidator.validateToolCall(req.tool_name);
    if (!check.allowed) {
      await this.stream.emitRuntime("system.error", {
        code: "lease_tool_denied",
        message: check.reason,
      });
      return {
        type: "tool_response",
        request_id: req.request_id,
        error: { code: "lease_tool_denied", message: check.reason },
      };
    }

    if (!this.isExecutionActive()) {
      return {
        type: "tool_response",
        request_id: req.request_id,
        error: {
          code: this.signal.aborted ? "execution_cancelled" : "execution_not_active",
          message: this.signal.aborted
            ? `execution is cancelled: ${String(this.signal.reason ?? "cancelled")}`
            : `execution is ${this.state.status}`,
        },
      };
    }

    try {
      const result = await this.dispatch(req.tool_name, req.params, req.request_id);
      this.assertExecutionActive();
      this.state.processed_request_ids.set(req.request_id, result);
      return { type: "tool_response", request_id: req.request_id, result };
    } catch (err) {
      const code = err instanceof ToolParameterError || err instanceof ToolExecutionStateError ? err.code : "internal";
      return {
        type: "tool_response",
        request_id: req.request_id,
        error: { code, message: String(err) },
      };
    }
  }

  private async dispatch(toolName: string, params: unknown, requestId: string): Promise<unknown> {
    switch (toolName) {
      case "bomcp.control.handoff":
        return this.handleControlHandoff(parseControlHandoffParams(params), requestId);
      case "bomcp.artifact.register":
        return this.handleArtifactRegister(parseArtifactRegisterParams(params), requestId);
      case "bomcp.artifact.require":
        return this.handleArtifactRequire(parseArtifactRequireParams(params), requestId);
      case "bomcp.progress.update":
        return this.handleProgressUpdate(parseProgressUpdateParams(params));
      default:
        throw new Error(`unknown tool: ${toolName}`);
    }
  }

  private async handleControlHandoff(params: ControlHandoffParams, requestId: string): Promise<HandoffAckResponse> {
    await this.emitAgentRequest("control.handoff", params, requestId);
    return { acknowledged: true, kind: params.kind };
  }

  private async handleArtifactRegister(params: ArtifactRegisterParams, requestId: string): Promise<ArtifactRegisterResponse> {
    const agentEnv = await this.emitAgentRequest("artifact.register", params, requestId);

    const resolvedPath = await this.resolveArtifactPath(params.path);
    if (resolvedPath.status !== "contained") {
      const reason = resolvedPath.status === "outside"
        ? "path_outside_artifact_root"
        : "file_not_found";
      await this.emitRuntimeRequired("artifact.registration_rejected", {
        kind: params.kind,
        path: params.path,
        reason,
      }, { reply_to: agentEnv.message_id });
      return { status: "rejected", reason };
    }

    this.assertExecutionActive();
    const artifactId = `art_${(++this.artifactCounter).toString(36)}`;
    this.state.artifacts.set(artifactId, {
      artifact_id: artifactId,
      kind: params.kind,
      path: params.path,
      metadata: params.metadata,
    });

    await this.emitRuntimeRequired("artifact.registered", {
      artifact_id: artifactId,
      kind: params.kind,
      path: params.path,
      status: "registered",
    }, { reply_to: agentEnv.message_id });

    return { artifact_id: artifactId, status: "registered" };
  }

  private async handleArtifactRequire(params: ArtifactRequireParams, requestId: string): Promise<ArtifactRequireResponse> {
    const agentEnv = await this.emitAgentRequest("artifact.require", params, requestId);

    const resolvedPath = await this.resolveArtifactPath(params.path);
    if (resolvedPath.status === "contained") {
      await this.emitRuntimeRequired("artifact.available", {
        kind: params.kind,
        path: params.path,
      }, { reply_to: agentEnv.message_id });
      return { status: "available", path: params.path };
    }
    if (resolvedPath.status === "outside") {
      return { status: "rejected", reason: "path_outside_artifact_root" };
    }

    await this.emitRuntimeRequired("artifact.missing", {
      kind: params.kind,
      path: params.path,
    }, { reply_to: agentEnv.message_id });
    return { status: "missing" };
  }

  private async handleProgressUpdate(params: ProgressUpdateParams): Promise<ProgressAckResponse> {
    const agentId = this.state.agent_id ?? "agent";
    const emission = await this.stream.emitAgent(agentId, "progress.update", {
      phase: params.phase,
      percent: params.percent,
      detail: params.detail,
    });
    this.assertDelivered(emission.delivered, "progress.update");
    return { acknowledged: true };
  }

  private async emitAgentRequest(kind: Parameters<ControllerStream["emitAgent"]>[1], payload: unknown, requestId: string) {
    const agentId = this.state.agent_id ?? "agent";
    const emission = await this.stream.emitAgent(agentId, kind, payload, { request_id: requestId });
    this.assertDelivered(emission.delivered, kind);
    return emission.envelope;
  }

  private async resolveArtifactPath(candidatePath: string): Promise<
    { status: "contained"; path: string } | { status: "missing" } | { status: "outside" }
  > {
    this.assertExecutionActive();
    if (!this.artifactRoot) {
      if (!await pathExists(candidatePath)) {
        return { status: "missing" };
      }
      return { status: "contained", path: path.resolve(candidatePath) };
    }

    const resolvedCandidate = path.resolve(this.artifactRoot, candidatePath);
    if (!await pathExists(resolvedCandidate)) {
      return { status: "missing" };
    }

    const contained = await resolveContainedRealPath(this.artifactRoot, resolvedCandidate);
    if (contained.status !== "contained") {
      return contained;
    }

    return { status: "contained", path: contained.path };
  }

  private async emitRuntimeRequired<P>(
    kind: Parameters<ControllerStream["emitRuntime"]>[0],
    payload: P,
    opts?: { reply_to?: string; request_id?: string },
  ): Promise<void> {
    const emission = await this.stream.emitRuntime(kind, payload, opts);
    this.assertDelivered(emission.delivered, kind);
  }

  private isExecutionActive(): boolean {
    return this.state.status === "running" && !this.signal.aborted;
  }

  private assertExecutionActive(): void {
    if (this.signal.aborted) {
      throw new ToolExecutionStateError(
        "execution_cancelled",
        `execution cancelled: ${String(this.signal.reason ?? "cancelled")}`,
      );
    }
    if (this.state.status !== "running") {
      throw new ToolExecutionStateError("execution_not_active", `execution is ${this.state.status}`);
    }
  }

  private assertDelivered(delivered: boolean, kind: string): void {
    if (!delivered) {
      throw new Error(`controller stream is closed; ${kind} was not delivered`);
    }
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}
