import type {
  ArtifactRegisterParams,
  ArtifactRequireParams,
  BomcpHandoffKind,
  ControlHandoffParams,
  HandoffInputRequest,
  HandoffTarget,
  ProgressUpdateParams,
} from "./types.ts";
import { BOMCP_HANDOFF_KINDS } from "./types.ts";
import { isPlainObject } from "../utils.ts";

export class ToolParameterError extends Error {
  readonly code = "invalid_tool_params";
}

export function parseControlHandoffParams(value: unknown): ControlHandoffParams {
  const record = expectRecord(value, "control.handoff params");
  const kind = expectNonEmptyString(record.kind, "kind");
  if (!BOMCP_HANDOFF_KINDS.includes(kind as (typeof BOMCP_HANDOFF_KINDS)[number])) {
    throw new ToolParameterError(`unknown handoff kind: ${String(kind)}`);
  }

  const params: ControlHandoffParams = {
    kind: kind as BomcpHandoffKind,
    reason_code: optionalNonEmptyString(record.reason_code, "reason_code"),
    description: optionalNonEmptyString(record.description, "description"),
    next: optionalHandoffTarget(record.next),
    input_request: optionalInputRequest(record.input_request),
    missing_refs: optionalStringArray(record.missing_refs, "missing_refs"),
    payload: optionalRecord(record.payload, "payload"),
  };

  if (params.kind === "continue_with_node" && !params.next?.node_id) {
    throw new ToolParameterError("continue_with_node requires next.node_id");
  }
  if (params.kind === "continue_with_prompt" && !params.next?.prompt_id) {
    throw new ToolParameterError("continue_with_prompt requires next.prompt_id");
  }
  if (params.kind === "needs_input" || params.kind === "needs_approval") {
    if (!params.input_request?.kind) {
      throw new ToolParameterError(`${params.kind} requires input_request.kind`);
    }
    if (!params.input_request?.prompt) {
      throw new ToolParameterError(`${params.kind} requires input_request.prompt`);
    }
  }

  return params;
}

export function parseArtifactRegisterParams(value: unknown): ArtifactRegisterParams {
  const record = expectRecord(value, "artifact.register params");
  return {
    kind: expectNonEmptyString(record.kind, "kind"),
    path: expectNonEmptyString(record.path, "path"),
    metadata: optionalRecord(record.metadata, "metadata"),
  };
}

export function parseArtifactRequireParams(value: unknown): ArtifactRequireParams {
  const record = expectRecord(value, "artifact.require params");
  return {
    kind: expectNonEmptyString(record.kind, "kind"),
    path: expectNonEmptyString(record.path, "path"),
  };
}

export function parseProgressUpdateParams(value: unknown): ProgressUpdateParams {
  const record = expectRecord(value, "progress.update params");
  const phase = optionalNonEmptyString(record.phase, "phase");
  const detail = optionalNonEmptyString(record.detail, "detail");
  const percent = optionalFiniteNumber(record.percent, "percent");
  if (phase === undefined && detail === undefined && percent === undefined) {
    throw new ToolParameterError("progress.update requires at least one of phase, percent, or detail");
  }
  return { phase, percent, detail };
}

function optionalHandoffTarget(value: unknown): HandoffTarget | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = expectRecord(value, "next");
  const node_id = optionalNonEmptyString(record.node_id, "next.node_id");
  const prompt_id = optionalNonEmptyString(record.prompt_id, "next.prompt_id");
  if (node_id === undefined && prompt_id === undefined) {
    throw new ToolParameterError("next must include node_id or prompt_id");
  }
  return { node_id, prompt_id };
}

function optionalInputRequest(value: unknown): HandoffInputRequest | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = expectRecord(value, "input_request");
  return {
    kind: expectNonEmptyString(record.kind, "input_request.kind"),
    prompt: expectNonEmptyString(record.prompt, "input_request.prompt"),
  };
}

function optionalStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new ToolParameterError(`${fieldName} must be an array of strings`);
  }
  return value.map((entry, index) => expectNonEmptyString(entry, `${fieldName}[${index}]`));
}

function optionalRecord(value: unknown, fieldName: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return expectRecord(value, fieldName);
}

function optionalFiniteNumber(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolParameterError(`${fieldName} must be a finite number`);
  }
  return value;
}

function optionalNonEmptyString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return expectNonEmptyString(value, fieldName);
}

function expectRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ToolParameterError(`${fieldName} must be an object`);
  }
  return value;
}

function expectNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolParameterError(`${fieldName} must be a non-empty string`);
  }
  return value;
}
