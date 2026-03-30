import path from "node:path";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { validateSchemaShape } from "../schema/validator.ts";
import { asRecord, isPlainObject } from "../utils.ts";
import {
  isPathInside,
  resolveContainedRealPath,
  isWorkspaceScopeContainedWithinSourceRoot,
  resolveWorkspaceScopeRoot
} from "../workspace/scope.ts";
import type {
  ExecutionRequest,
  NormalizedExecutionRequest,
  ValidationIssue,
} from "../types.ts";
import {
  BACKEND_NAMES,
  MCP_APPROVAL_MODES,
  MCP_TRANSPORTS,
  OUTPUT_FORMATS,
  OUTPUT_SCHEMA_ENFORCEMENTS,
  TOOL_POLICY_MODES
} from "../types.ts";
import { BOMCP_TOOL_NAMES } from "../bomcp/types.ts";
import {
  isOneOf,
  isValidMimeType,
  isValidUrlString,
  type ResolvedAttachmentPath,
} from "./shared.ts";

export async function validateRequest(
  request: NormalizedExecutionRequest,
  rawRequest: ExecutionRequest,
  rawRecord: Record<string, unknown>,
): Promise<{
  issues: ValidationIssue[];
  resolvedAttachmentPaths: ResolvedAttachmentPath[];
}> {
  const issues: ValidationIssue[] = [];
  const resolvedAttachmentPaths: ResolvedAttachmentPath[] = [];
  const rawRuntime = asRecord(rawRequest.runtime);
  const rawOutput = asRecord(rawRequest.output);
  const rawPolicy = asRecord(rawRecord.policy);
  const rawWorkspace = asRecord(rawRequest.workspace);
  const rawTask = asRecord(rawRequest.task);
  const rawContinuation = asRecord(rawRequest.continuation);
  const rawExecutionProfile = asRecord(rawRequest.execution_profile);
  const rawToolConfiguration = asRecord(rawRequest.tool_configuration);
  const rawBuiltinPolicy = asRecord(rawToolConfiguration?.builtin_policy);

  if (!isOneOf(request.backend, BACKEND_NAMES)) {
    issues.push({ path: "$.backend", message: `must be one of ${BACKEND_NAMES.join(" or ")}` });
  }
  if (!rawExecutionProfile) {
    issues.push({ path: "$.execution_profile", message: "must be an object" });
  }
  if ("runtime" in rawRequest && rawRequest.runtime !== undefined && !rawRuntime) {
    issues.push({ path: "$.runtime", message: "must be an object when provided" });
  }
  if ("continuation" in rawRequest && rawRequest.continuation !== undefined && !rawContinuation) {
    issues.push({ path: "$.continuation", message: "must be an object when provided" });
  }
  if ("workspace" in rawRequest && rawRequest.workspace !== undefined && !rawWorkspace) {
    issues.push({ path: "$.workspace", message: "must be an object when provided" });
  }
  if ("policy" in rawRequest) {
    issues.push({
      path: "$.policy",
      message: "has been removed; bo_staff no longer exposes a public policy block"
    });
  }
  if ("output" in rawRequest && rawRequest.output !== undefined && !rawOutput) {
    issues.push({ path: "$.output", message: "must be an object when provided" });
  }
  if ("tool_configuration" in rawRequest && rawRequest.tool_configuration !== undefined && !rawToolConfiguration) {
    issues.push({ path: "$.tool_configuration", message: "must be an object when provided" });
  }
  if ("capabilities" in rawRecord) {
    issues.push({ path: "$.capabilities", message: "has been removed; bo_staff no longer exposes a public capabilities block" });
  }
  if ("isolation" in rawRecord) {
    issues.push({ path: "$.isolation", message: "has been removed; bo_staff no longer manages git workspace isolation" });
  }
  if (rawWorkspace && "topology" in rawWorkspace) {
    issues.push({ path: "$.workspace.topology", message: "is not a public request field; bo_staff uses direct workspace topology internally" });
  }
  if (rawWorkspace && "sandbox" in rawWorkspace) {
    issues.push({ path: "$.workspace.sandbox", message: "has been removed; bo_staff no longer exposes provider sandbox controls" });
  }
  if ("session" in rawRequest) {
    issues.push({ path: "$.session", message: "has been removed; bo_staff does not manage session lifecycle" });
  }
  if (rawWorkspace && "write_scope" in rawWorkspace) {
    issues.push({ path: "$.workspace.write_scope", message: "has been removed from the public contract" });
  }
  if (rawPolicy && "control_gates" in rawPolicy) {
    issues.push({ path: "$.policy.control_gates", message: "has been removed with the public policy block" });
  }
  if (!request.execution_profile.model.trim()) {
    issues.push({ path: "$.execution_profile.model", message: "must be a non-empty string" });
  }
  if (!request.task.prompt.trim()) {
    issues.push({ path: "$.task.prompt", message: "must be a non-empty string" });
  }
  if (rawTask && "objective" in rawTask && rawTask.objective !== undefined && typeof rawTask.objective !== "string") {
    issues.push({ path: "$.task.objective", message: "must be a string when provided" });
  } else if (typeof request.task.objective === "string" && request.task.objective.trim() === "") {
    issues.push({ path: "$.task.objective", message: "must be a non-empty string when provided" });
  }
  if (rawTask && "context" in rawTask && rawTask.context !== undefined && !isPlainObject(rawTask.context)) {
    issues.push({ path: "$.task.context", message: "must be an object when provided" });
  }
  if (rawTask && "constraints" in rawTask) {
    if (!Array.isArray(rawTask.constraints)) {
      issues.push({ path: "$.task.constraints", message: "must be an array of strings when provided" });
    } else {
      rawTask.constraints.forEach((entry, index) => {
        if (typeof entry !== "string") {
          issues.push({ path: `$.task.constraints[${index}]`, message: "must be a string" });
        }
      });
    }
  }
  if (rawTask && "attachments" in rawTask) {
    if (!Array.isArray(rawTask.attachments)) {
      issues.push({ path: "$.task.attachments", message: "must be an array when provided" });
    } else {
      rawTask.attachments.forEach((entry, index) => {
        const record = asRecord(entry);
        if (!record) {
          issues.push({ path: `$.task.attachments[${index}]`, message: "must be an object" });
          return;
        }
        if (typeof record.name !== "string" || record.name.trim() === "") {
          issues.push({ path: `$.task.attachments[${index}].name`, message: "must be a non-empty string" });
        }
        if ("mime_type" in record && record.mime_type !== undefined && typeof record.mime_type !== "string") {
          issues.push({ path: `$.task.attachments[${index}].mime_type`, message: "must be a string when provided" });
        } else if (typeof record.mime_type === "string" && !isValidMimeType(record.mime_type)) {
          issues.push({ path: `$.task.attachments[${index}].mime_type`, message: "must be a valid MIME type when provided" });
        }
        if ("description" in record && record.description !== undefined && typeof record.description !== "string") {
          issues.push({ path: `$.task.attachments[${index}].description`, message: "must be a string when provided" });
        }
        const hasPath = typeof record.path === "string";
        const hasContent = typeof record.content === "string";
        if (hasPath === hasContent) {
          issues.push({ path: `$.task.attachments[${index}]`, message: "attachment must define exactly one of path or content" });
        }
      });
    }
  }
  if (request.workspace.kind === "provided" && !request.workspace.source_root) {
    issues.push({ path: "$.workspace.source_root", message: "must be a non-empty absolute path" });
  }
  if (rawWorkspace && "source_root" in rawWorkspace && typeof rawWorkspace.source_root !== "string") {
    issues.push({ path: "$.workspace.source_root", message: "must be a string" });
  }
  if (rawWorkspace && typeof rawWorkspace.source_root === "string" && !path.isAbsolute(rawWorkspace.source_root)) {
    issues.push({ path: "$.workspace.source_root", message: "must be an absolute path" });
  }
  if (request.workspace.kind === "provided" && request.workspace.source_root) {
    try {
      await access(request.workspace.source_root, constants.R_OK);
      const sourceRootStat = await stat(request.workspace.source_root);
      if (!sourceRootStat.isDirectory()) {
        issues.push({ path: "$.workspace.source_root", message: "must be a directory" });
      }
    } catch {
      issues.push({ path: "$.workspace.source_root", message: "must exist and be readable" });
    }
  }
  if (request.workspace.scope.mode === "subpath") {
    if (request.workspace.kind !== "provided") {
      issues.push({
        path: "$.workspace.scope.subpath",
        message: "requires a caller-provided workspace.source_root"
      });
      return { issues, resolvedAttachmentPaths };
    }
    if (!request.workspace.scope.subpath) {
      issues.push({ path: "$.workspace.scope.subpath", message: "is required when workspace.scope.mode=subpath" });
    } else if (!isWorkspaceScopeContainedWithinSourceRoot(request.workspace)) {
      issues.push({
        path: "$.workspace.scope.subpath",
        message: "must stay within workspace.source_root"
      });
    } else {
      const scopedRoot = resolveWorkspaceScopeRoot(request.workspace);
      const containedScopedRoot = await resolveContainedRealPath(request.workspace.source_root, scopedRoot);
      if (containedScopedRoot.status !== "contained") {
        issues.push({
          path: "$.workspace.scope.subpath",
          message: containedScopedRoot.status === "missing"
            ? "must exist and be readable"
            : "must resolve within workspace.source_root after symlink resolution"
        });
        return { issues, resolvedAttachmentPaths };
      }
      try {
        await access(scopedRoot, constants.R_OK);
        const scopedRootStat = await stat(scopedRoot);
        if (!scopedRootStat.isDirectory()) {
          issues.push({
            path: "$.workspace.scope.subpath",
            message: "must resolve to a directory"
          });
        }
      } catch {
        issues.push({
          path: "$.workspace.scope.subpath",
          message: "must exist and be readable"
        });
      }
    }
  }
  validateContinuation(request, rawContinuation, issues);
  if (rawRuntime && "timeout_ms" in rawRuntime) {
    const rawTimeoutMs = rawRuntime.timeout_ms;
    if (typeof rawTimeoutMs !== "number" || !Number.isInteger(rawTimeoutMs) || rawTimeoutMs <= 0) {
      issues.push({ path: "$.runtime.timeout_ms", message: "must be a positive integer when provided" });
    }
  }
  if (rawRuntime && "max_turns" in rawRuntime) {
    const rawMaxTurns = rawRuntime.max_turns;
    if (typeof rawMaxTurns !== "number" || !Number.isInteger(rawMaxTurns) || rawMaxTurns <= 0) {
      issues.push({ path: "$.runtime.max_turns", message: "must be a positive integer when provided" });
    }
  }
  if (rawPolicy && "isolation" in rawPolicy) {
    issues.push({
      path: "$.policy.isolation",
      message: "has been removed with the public policy block"
    });
  }
  if (rawPolicy && "approvals" in rawPolicy) {
    issues.push({ path: "$.policy.approvals", message: "has been removed with the public policy block" });
  }
  if (rawPolicy && "filesystem" in rawPolicy) {
    issues.push({ path: "$.policy.filesystem", message: "has been removed with the public policy block" });
  }
  if (rawOutput) {
    if ("schema" in rawOutput && rawOutput.schema !== undefined && !isPlainObject(rawOutput.schema)) {
      issues.push({ path: "$.output.schema", message: "must be an object" });
    } else if ("schema" in rawOutput && isPlainObject(rawOutput.schema)) {
      issues.push(...validateSchemaShape(request.output.schema, "$.output.schema"));
    } else if (request.output.format === "custom") {
      issues.push({ path: "$.output.schema", message: "is required when output.format=custom" });
    }
  }
  if (rawOutput && "format" in rawOutput && !isOneOf(rawOutput.format, OUTPUT_FORMATS)) {
    issues.push({ path: "$.output.format", message: "must be one of message or custom" });
  }
  if (rawOutput && "schema_enforcement" in rawOutput && !isOneOf(rawOutput.schema_enforcement, OUTPUT_SCHEMA_ENFORCEMENTS)) {
    issues.push({ path: "$.output.schema_enforcement", message: "must be one of strict or advisory" });
  }
  if (rawToolConfiguration) {
    if (rawBuiltinPolicy !== undefined && !rawBuiltinPolicy) {
      issues.push({ path: "$.tool_configuration.builtin_policy", message: "must be an object when provided" });
    }
    if (rawBuiltinPolicy) {
      if (!isOneOf(rawBuiltinPolicy.mode, TOOL_POLICY_MODES)) {
        issues.push({ path: "$.tool_configuration.builtin_policy.mode", message: "must be one of default, allowlist, or denylist" });
      }
      if (rawBuiltinPolicy.mode === "allowlist" || rawBuiltinPolicy.mode === "denylist") {
        if (!Array.isArray(rawBuiltinPolicy.tools)) {
          issues.push({ path: "$.tool_configuration.builtin_policy.tools", message: "must be an array of strings" });
        }
      }
      if (Array.isArray(rawBuiltinPolicy.tools)) {
        rawBuiltinPolicy.tools.forEach((entry, index) => {
          if (typeof entry !== "string" || entry.trim() === "") {
            issues.push({ path: `$.tool_configuration.builtin_policy.tools[${index}]`, message: "must be a non-empty string" });
          }
        });
      }
    }
    if ("mcp_servers" in rawToolConfiguration && rawToolConfiguration.mcp_servers !== undefined) {
      if (!Array.isArray(rawToolConfiguration.mcp_servers)) {
        issues.push({ path: "$.tool_configuration.mcp_servers", message: "must be an array when provided" });
      } else {
        rawToolConfiguration.mcp_servers.forEach((entry, index) => validateMcpServer(entry, index, issues));
      }
    }
  }

  if ("lease" in rawRecord && rawRecord.lease !== undefined) {
    const rawLease = asRecord(rawRecord.lease);
    if (!rawLease) {
      issues.push({ path: "$.lease", message: "must be an object when provided" });
    } else {
      if ("allowed_tools" in rawLease && rawLease.allowed_tools !== undefined) {
        if (!Array.isArray(rawLease.allowed_tools)) {
          issues.push({ path: "$.lease.allowed_tools", message: "must be an array of strings when provided" });
        } else {
          const validToolNames = new Set<string>(BOMCP_TOOL_NAMES);
          rawLease.allowed_tools.forEach((entry, index) => {
            if (typeof entry !== "string") {
              issues.push({ path: `$.lease.allowed_tools[${index}]`, message: "must be a string" });
            } else if (!validToolNames.has(entry)) {
              issues.push({ path: `$.lease.allowed_tools[${index}]`, message: "must be a valid bomcp tool name" });
            }
          });
        }
      }
      if ("timeout_seconds" in rawLease && rawLease.timeout_seconds !== undefined) {
        if (typeof rawLease.timeout_seconds !== "number" || rawLease.timeout_seconds <= 0) {
          issues.push({ path: "$.lease.timeout_seconds", message: "must be a positive number when provided" });
        }
      }
    }
  }

  for (const [index, attachment] of request.task.attachments.entries()) {
    if (attachment.kind === "path") {
      if (request.workspace.kind !== "provided") {
        issues.push({
          path: `$.task.attachments[${index}].path`,
          message: "requires a caller-provided workspace.source_root"
        });
        continue;
      }
      const effectiveWorkspaceRoot = resolveWorkspaceScopeRoot(request.workspace);
      const candidatePath = path.resolve(effectiveWorkspaceRoot, attachment.path);
      if (!isPathInside(effectiveWorkspaceRoot, candidatePath)) {
        issues.push({
          path: `$.task.attachments[${index}].path`,
          message: "must stay within the effective workspace scope"
        });
        continue;
      }
      const containedAttachmentPath = await resolveContainedRealPath(effectiveWorkspaceRoot, candidatePath);
      if (containedAttachmentPath.status !== "contained") {
        issues.push({
          path: `$.task.attachments[${index}].path`,
          message: containedAttachmentPath.status === "missing"
            ? "must exist and be readable"
            : "must resolve within the effective workspace scope after symlink resolution"
        });
        continue;
      }
      resolvedAttachmentPaths.push({ index, path: containedAttachmentPath.path });
    }
  }
  return { issues, resolvedAttachmentPaths };
}

function validateMcpServer(value: unknown, index: number, issues: ValidationIssue[]): void {
  const record = asRecord(value);
  if (!record) {
    issues.push({ path: `$.tool_configuration.mcp_servers[${index}]`, message: "must be an object" });
    return;
  }
  if (typeof record.name !== "string" || record.name.trim() === "") {
    issues.push({ path: `$.tool_configuration.mcp_servers[${index}].name`, message: "must be a non-empty string" });
  } else if (record.name === "bomcp") {
    issues.push({ path: `$.tool_configuration.mcp_servers[${index}].name`, message: "the 'bomcp' MCP server name is reserved by bo_staff" });
  }
  if (!isOneOf(record.transport, MCP_TRANSPORTS)) {
    issues.push({ path: `$.tool_configuration.mcp_servers[${index}].transport`, message: "must be one of stdio or sse" });
  }
  if (record.transport === "stdio" && (typeof record.command !== "string" || record.command.trim() === "")) {
    issues.push({ path: `$.tool_configuration.mcp_servers[${index}].command`, message: "is required when transport=stdio" });
  }
  if (record.transport === "sse" && (typeof record.url !== "string" || record.url.trim() === "")) {
    issues.push({ path: `$.tool_configuration.mcp_servers[${index}].url`, message: "is required when transport=sse" });
  } else if (record.transport === "sse" && typeof record.url === "string" && !isValidUrlString(record.url)) {
    issues.push({ path: `$.tool_configuration.mcp_servers[${index}].url`, message: "must be a valid URL when transport=sse" });
  }
  if ("args" in record && record.args !== undefined) {
    if (!Array.isArray(record.args)) {
      issues.push({ path: `$.tool_configuration.mcp_servers[${index}].args`, message: "must be an array of strings when provided" });
    } else {
      record.args.forEach((entry, argIndex) => {
        if (typeof entry !== "string") {
          issues.push({ path: `$.tool_configuration.mcp_servers[${index}].args[${argIndex}]`, message: "must be a string" });
        }
      });
    }
  }
  if ("env" in record && record.env !== undefined && !isPlainObject(record.env)) {
    issues.push({ path: `$.tool_configuration.mcp_servers[${index}].env`, message: "must be an object when provided" });
  }
  if ("headers" in record && record.headers !== undefined && !isPlainObject(record.headers)) {
    issues.push({ path: `$.tool_configuration.mcp_servers[${index}].headers`, message: "must be an object when provided" });
  }
  if ("require_approval" in record && record.require_approval !== undefined && !isOneOf(record.require_approval, MCP_APPROVAL_MODES)) {
    issues.push({
      path: `$.tool_configuration.mcp_servers[${index}].require_approval`,
      message: `must be one of ${MCP_APPROVAL_MODES.join(" or ")} when provided`,
    });
  }
}

function validateContinuation(
  request: NormalizedExecutionRequest,
  rawContinuation: Record<string, unknown> | undefined,
  issues: ValidationIssue[]
): void {
  if (!rawContinuation) {
    return;
  }
  if (typeof rawContinuation.backend !== "string" || !isOneOf(rawContinuation.backend, BACKEND_NAMES)) {
    issues.push({ path: "$.continuation.backend", message: `must be one of ${BACKEND_NAMES.join(" or ")}` });
  }
  if (typeof rawContinuation.token !== "string" || rawContinuation.token.trim() === "") {
    issues.push({ path: "$.continuation.token", message: "must be a non-empty string" });
  }
  if (request.continuation && request.continuation.backend !== request.backend) {
    issues.push({ path: "$.continuation.backend", message: "must match request.backend" });
  }
}
