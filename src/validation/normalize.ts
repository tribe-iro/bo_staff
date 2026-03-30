import path from "node:path";
import { DEFAULT_MESSAGE_OUTPUT_SCHEMA } from "../config/defaults.ts";
import { asRecord, isPlainObject, normalizeAbsolutePath } from "../utils.ts";
import type {
  Attachment,
  BuiltinToolPolicy,
  ContinuationReference,
  ExecutionRequest,
  JsonSchema,
  McpServerSpec,
  NormalizedExecutionRequest,
} from "../types.ts";
import {
  BACKEND_NAMES,
  MCP_APPROVAL_MODES,
  MCP_TRANSPORTS,
  OUTPUT_FORMATS,
  OUTPUT_SCHEMA_ENFORCEMENTS,
  TOOL_POLICY_MODES
} from "../types.ts";
import { isOneOf, normalizeTimeoutMs } from "./shared.ts";

export function normalizeRequest(request: ExecutionRequest): NormalizedExecutionRequest {
  const rawTask = asRecord(request.task);
  const rawContinuation = asRecord(request.continuation);
  const rawWorkspace = asRecord(request.workspace);
  const rawScope = asRecord(rawWorkspace?.scope);
  const rawRuntime = asRecord(request.runtime);
  const rawExecutionProfile = asRecord(request.execution_profile);
  const rawOutput = asRecord(request.output);
  const rawToolConfiguration = asRecord(request.tool_configuration);
  const rawBuiltinPolicy = asRecord(rawToolConfiguration?.builtin_policy);
  const normalizedSourceRoot = typeof rawWorkspace?.source_root === "string"
    && rawWorkspace.source_root !== ""
    && path.isAbsolute(rawWorkspace.source_root)
    ? normalizeAbsolutePath(rawWorkspace.source_root)
    : null;
  const normalizedScope = {
    mode: rawScope?.mode === "subpath" ? "subpath" as const : "full" as const,
    subpath: typeof rawScope?.subpath === "string" ? rawScope.subpath : undefined
  };
  const format = isOneOf(rawOutput?.format, OUTPUT_FORMATS) ? rawOutput.format : "message";
  const normalizedOutputSchema = isPlainObject(rawOutput?.schema)
    ? rawOutput.schema as JsonSchema
    : structuredClone(DEFAULT_MESSAGE_OUTPUT_SCHEMA);
  const schemaEnforcement = isOneOf(rawOutput?.schema_enforcement, OUTPUT_SCHEMA_ENFORCEMENTS)
    ? rawOutput.schema_enforcement
    : format === "custom"
      ? "strict"
      : "advisory";
  const workspaceKind = rawWorkspace ? "provided" as const : "ephemeral" as const;
  const normalizedAttachments = Array.isArray(rawTask?.attachments)
    ? rawTask.attachments.flatMap((entry) => normalizeAttachmentInput(entry))
    : [];
  const normalizedToolConfiguration = normalizeToolConfiguration(rawToolConfiguration, rawBuiltinPolicy);

  return {
    backend: request.backend,
    execution_profile: {
      model: typeof rawExecutionProfile?.model === "string" ? rawExecutionProfile.model : "",
      reasoning_effort: typeof rawExecutionProfile?.reasoning_effort === "string"
        ? rawExecutionProfile.reasoning_effort
        : undefined
    },
    runtime: {
      timeout_ms: normalizeTimeoutMs(rawRuntime?.timeout_ms),
      max_turns: typeof rawRuntime?.max_turns === "number" && Number.isInteger(rawRuntime.max_turns) && rawRuntime.max_turns > 0
        ? rawRuntime.max_turns
        : undefined
    },
    task: {
      prompt: typeof rawTask?.prompt === "string" ? rawTask.prompt : "",
      objective: typeof rawTask?.objective === "string" ? rawTask.objective : undefined,
      context: isPlainObject(rawTask?.context) ? rawTask.context : {},
      attachments: normalizedAttachments,
      constraints: Array.isArray(rawTask?.constraints)
        ? rawTask.constraints.filter((entry): entry is string => typeof entry === "string")
        : []
    },
    continuation: normalizeContinuation(rawContinuation),
    workspace: workspaceKind === "provided"
      ? {
        kind: "provided",
        topology: "direct",
        source_root: normalizedSourceRoot ?? "",
        scope: normalizedScope,
      }
      : {
        kind: "ephemeral",
        topology: "direct",
        source_root: null,
        scope: { mode: "full" },
      },
    output: {
      format,
      schema: normalizedOutputSchema,
      schema_enforcement: schemaEnforcement
    },
    tool_configuration: normalizedToolConfiguration,
    metadata: isPlainObject(request.metadata) ? request.metadata : {}
  };
}

function normalizeContinuation(rawContinuation: Record<string, unknown> | undefined): ContinuationReference | undefined {
  if (!rawContinuation) {
    return undefined;
  }
  if (typeof rawContinuation.backend !== "string" || typeof rawContinuation.token !== "string") {
    return undefined;
  }
  if (!isOneOf(rawContinuation.backend, BACKEND_NAMES) || rawContinuation.token.trim() === "") {
    return undefined;
  }
  return {
    backend: rawContinuation.backend,
    token: rawContinuation.token
  };
}

function normalizeToolConfiguration(
  rawToolConfiguration: Record<string, unknown> | undefined,
  rawBuiltinPolicy: Record<string, unknown> | undefined
): NormalizedExecutionRequest["tool_configuration"] {
  if (!rawToolConfiguration) {
    return undefined;
  }
  const builtinPolicy: BuiltinToolPolicy = {
    mode: isOneOf(rawBuiltinPolicy?.mode, TOOL_POLICY_MODES) ? rawBuiltinPolicy.mode : "default",
    tools: Array.isArray(rawBuiltinPolicy?.tools)
      ? rawBuiltinPolicy.tools.filter((entry): entry is string => typeof entry === "string")
      : undefined
  };
  const mcpServers = Array.isArray(rawToolConfiguration.mcp_servers)
    ? rawToolConfiguration.mcp_servers.flatMap((entry) => normalizeMcpServer(entry))
    : [];
  return {
    builtin_policy: builtinPolicy,
    mcp_servers: mcpServers
  };
}

function normalizeMcpServer(value: unknown): McpServerSpec[] {
  const record = asRecord(value);
  if (!record || typeof record.name !== "string" || !isOneOf(record.transport, MCP_TRANSPORTS)) {
    return [];
  }
  return [{
    name: record.name,
    transport: record.transport,
    command: typeof record.command === "string" ? record.command : undefined,
    args: Array.isArray(record.args) ? record.args.filter((entry): entry is string => typeof entry === "string") : undefined,
    url: typeof record.url === "string" ? record.url : undefined,
    env: isPlainObject(record.env)
      ? Object.fromEntries(Object.entries(record.env).filter(([, entry]) => typeof entry === "string")) as Record<string, string>
      : undefined,
    headers: isPlainObject(record.headers)
      ? Object.fromEntries(Object.entries(record.headers).filter(([, entry]) => typeof entry === "string")) as Record<string, string>
      : undefined,
    require_approval: isOneOf(record.require_approval, MCP_APPROVAL_MODES) ? record.require_approval : undefined,
  }];
}

function normalizeAttachmentInput(value: unknown): Attachment[] {
  const attachment = asRecord(value);
  if (!attachment || typeof attachment.name !== "string") {
    return [];
  }
  const base = {
    name: String(attachment.name),
    mime_type: typeof attachment.mime_type === "string" ? attachment.mime_type : undefined,
    description: typeof attachment.description === "string" ? attachment.description : undefined
  };
  const hasPath = typeof attachment.path === "string";
  const hasContent = typeof attachment.content === "string";
  if (hasPath === hasContent) {
    return [];
  }
  if (hasPath) {
    return [{
      kind: "path",
      ...base,
      path: attachment.path as string
    }];
  }
  return [{
    kind: "inline",
    ...base,
    content: attachment.content as string
  }];
}
