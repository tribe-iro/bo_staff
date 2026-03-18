import { buildCapabilityDiagnostic, buildUnavailableOutcome } from "../compat/degradation.ts";
import { CAPABILITY_NAMES } from "../core/index.ts";
import type {
  ArtifactRecord,
  BoStaffEvent,
  BoStaffEventName,
  CapabilityDiagnostic,
  CapabilityName,
  ControlGateRecord,
  ExecutionResponse,
  ExecutionSummary
} from "../types.ts";
import type { AdapterEvent } from "../adapters/types.ts";
import type { BoStaffRepository } from "../persistence/types.ts";
import { EventLog } from "./event-log.ts";

export async function recordExecutionEvent<T extends Record<string, unknown>>(input: {
  repository: BoStaffRepository;
  log: EventLog;
  executionId: string;
  event: BoStaffEventName;
  data: T;
  projections?: {
    artifacts?: ArtifactRecord[];
    control_gates?: ControlGateRecord[];
  };
}): Promise<number> {
  const entry = await input.log.append(input.event, input.data);
  return input.repository.appendExecutionEvent({
    execution_id: input.executionId,
    event: entry,
    artifacts: input.projections?.artifacts,
    control_gates: input.projections?.control_gates
  });
}

export function buildLifecycleTerminalEvent(input: {
  log: EventLog;
  status: Extract<ExecutionSummary["status"], "completed" | "partial" | "failed" | "awaiting_control_gate">;
  message?: string;
}): BoStaffEvent {
  if (input.status === "completed" || input.status === "partial") {
    return input.log.build("execution.completed", { status: input.status });
  }
  if (input.status === "failed") {
    return input.log.build("execution.failed", {
      status: input.status,
      ...(input.message ? { message: input.message } : {})
    });
  }
  return input.log.build("execution.awaiting_control_gate", { status: input.status });
}

export function buildResponseEvent(log: EventLog, response: ExecutionResponse): BoStaffEvent {
  return log.build("execution.snapshot", { response });
}

export async function projectAdapterEvent(input: {
  repository: BoStaffRepository;
  executionId: string;
  log: EventLog;
  event: AdapterEvent;
  artifactMap: Map<string, ArtifactRecord>;
  controlGateMap: Map<string, ControlGateRecord>;
}): Promise<void> {
  switch (input.event.type) {
    case "provider.progress":
    case "provider.output.chunk":
      await recordExecutionEvent({
        repository: input.repository,
        log: input.log,
        executionId: input.executionId,
        event: "execution.progressed",
        data: {
          bytes: input.event.type === "provider.output.chunk" ? input.event.text.length : undefined,
          message: input.event.type === "provider.progress" ? input.event.message : undefined
        }
      });
      return;
    case "provider.control_gate.upsert":
      input.controlGateMap.set(input.event.gate.control_gate_id, input.event.gate);
      await recordExecutionEvent({
        repository: input.repository,
        log: input.log,
        executionId: input.executionId,
        event: "control_gate.requested",
        data: {
          control_gate_id: input.event.gate.control_gate_id,
          kind: input.event.gate.kind
        },
        projections: { control_gates: [...input.controlGateMap.values()] }
      });
      return;
    case "provider.control_gate.resolved": {
      const existing = input.controlGateMap.get(input.event.control_gate_id);
      if (existing) {
        input.controlGateMap.set(input.event.control_gate_id, {
          ...existing,
          status: input.event.resolution === "approved" ? "approved" : "denied",
          resolved_at: input.event.resolved_at
        });
      }
      await recordExecutionEvent({
        repository: input.repository,
        log: input.log,
        executionId: input.executionId,
        event: "control_gate.resolved",
        data: {
          control_gate_id: input.event.control_gate_id,
          resolution: input.event.resolution
        },
        projections: { control_gates: [...input.controlGateMap.values()] }
      });
      return;
    }
    case "provider.artifact.upsert":
      input.artifactMap.set(input.event.artifact.artifact_id, input.event.artifact);
      await recordExecutionEvent({
        repository: input.repository,
        log: input.log,
        executionId: input.executionId,
        event: "artifact.produced",
        data: {
          artifact_id: input.event.artifact.artifact_id,
          kind: input.event.artifact.kind
        },
        projections: { artifacts: [...input.artifactMap.values()] }
      });
      return;
    default:
      return;
  }
}

export function buildValidationRejectionCapabilityState(): {
  capabilities: ExecutionResponse["capabilities"];
  diagnostics: Record<CapabilityName, CapabilityDiagnostic>;
} {
  const outcomes = {} as Record<CapabilityName, ExecutionResponse["capabilities"][CapabilityName]>;
  const diagnostics = {} as Record<CapabilityName, CapabilityDiagnostic>;
  for (const capability of CAPABILITY_NAMES) {
    outcomes[capability] = buildUnavailableOutcome("Request rejected before execution dispatch.");
    diagnostics[capability] = buildCapabilityDiagnostic(capability, {
      enforcement_source: "none",
      delivery_mode: "degraded",
      compatibility_policy_path: "gateway.validation.rejected_capabilities"
    });
  }
  return { capabilities: outcomes, diagnostics };
}
