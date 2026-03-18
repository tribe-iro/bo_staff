import path from "node:path";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { validateSchemaShape } from "./schema/validator.ts";
import { DEFAULT_MESSAGE_OUTPUT_SCHEMA, resolveDefaultExecutionTimeoutMs } from "./config/defaults.ts";
import { asRecord, isPlainObject, normalizeAbsolutePath } from "./utils.ts";
import {
  isPathInside,
  resolveContainedRealPath,
  isWorkspaceScopeContainedWithinSourceRoot,
  resolveWorkspaceScopeRoot
} from "./workspace/scope.ts";
import type {
  Attachment,
  AttachmentInput,
  ExecutionPolicy,
  ExecutionRequest,
  JsonSchema,
  NormalizedExecutionRequest,
  ValidationIssue,
  ValidationResult
} from "./types.ts";
import {
  BACKEND_NAMES,
  OUTPUT_FORMATS,
  POLICY_APPROVAL_MODES,
  POLICY_FILESYSTEM_MODES,
  POLICY_ISOLATION_MODES,
  SELECTION_MODES
} from "./types.ts";
import { SESSION_MODES } from "./core/index.ts";
import { isSafeSessionHandle } from "./core/index.ts";
import { PERFORMANCE_TIERS, REASONING_TIERS } from "./engine/types.ts";

export async function normalizeAndValidateRequest(request: unknown): Promise<ValidationResult<NormalizedExecutionRequest>> {
  if (!isPlainObject(request)) {
    return { ok: false, issues: [{ path: "$", message: "request must be an object" }] };
  }
  const executionRequest = request as unknown as ExecutionRequest;
  const normalized = normalizeRequest(executionRequest);
  const validation = await validateRequest(normalized, executionRequest);
  const issues = validation.issues;
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: applyResolvedAttachmentPaths(normalized, validation.resolvedAttachmentPaths),
    issues: []
  };
}

function normalizeRequest(request: ExecutionRequest): NormalizedExecutionRequest {
  const rawTask = asRecord(request.task);
  const rawSession = asRecord(request.session);
  const rawWorkspace = asRecord(request.workspace);
  const rawScope = asRecord(rawWorkspace?.scope);
  const rawPolicy = asRecord(request.policy);
  const rawRuntime = asRecord(request.runtime);
  const rawExecutionProfile = asRecord(request.execution_profile);
  const rawOutput = asRecord(request.output);
  const performanceTier = isOneOf(rawExecutionProfile?.performance_tier, PERFORMANCE_TIERS)
    ? rawExecutionProfile.performance_tier
    : "balanced";
  const normalizedSourceRoot = typeof rawWorkspace?.source_root === "string"
    && rawWorkspace.source_root !== ""
    && path.isAbsolute(rawWorkspace.source_root)
    ? normalizeAbsolutePath(rawWorkspace.source_root)
    : null;
  const normalizedScope = {
    mode: rawScope?.mode === "subpath" ? "subpath" as const : "full" as const,
    subpath: typeof rawScope?.subpath === "string" ? rawScope.subpath : undefined
  };
  const normalizedPolicy: ExecutionPolicy = {
    isolation: isOneOf(rawPolicy?.isolation, POLICY_ISOLATION_MODES) ? rawPolicy.isolation : "default",
    approvals: isOneOf(rawPolicy?.approvals, POLICY_APPROVAL_MODES) ? rawPolicy.approvals : "default",
    filesystem: isOneOf(rawPolicy?.filesystem, POLICY_FILESYSTEM_MODES) ? rawPolicy.filesystem : "default"
  };
  const normalizedOutputSchema = isPlainObject(rawOutput?.schema)
    ? rawOutput.schema as JsonSchema
    : structuredClone(DEFAULT_MESSAGE_OUTPUT_SCHEMA);
  const workspaceKind = rawWorkspace ? "provided" as const : "ephemeral" as const;
  const normalizedAttachments = Array.isArray(rawTask?.attachments)
    ? rawTask.attachments.flatMap((entry) => normalizeAttachmentInput(entry))
    : [];

  return {
    backend: request.backend,
    execution_profile: {
      performance_tier: performanceTier,
      reasoning_tier: isOneOf(rawExecutionProfile?.reasoning_tier, REASONING_TIERS)
        ? rawExecutionProfile.reasoning_tier
        : "standard",
      selection_mode: isOneOf(rawExecutionProfile?.selection_mode, SELECTION_MODES)
        ? rawExecutionProfile.selection_mode
        : "managed",
      pin: typeof rawExecutionProfile?.pin === "string" ? rawExecutionProfile.pin : undefined,
      override: typeof rawExecutionProfile?.override === "string" ? rawExecutionProfile.override : undefined
    },
    runtime: {
      timeout_ms: normalizeTimeoutMs(rawRuntime?.timeout_ms, performanceTier)
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
    session: {
      mode: isOneOf(rawSession?.mode, SESSION_MODES) ? rawSession.mode : "new",
      handle: typeof rawSession?.handle === "string" || rawSession?.handle === null ? rawSession.handle : null
    },
    workspace: workspaceKind === "provided"
      ? {
        kind: "provided",
        topology: normalizedPolicy.isolation === "require_workspace_isolation" ? "git_isolated" : "direct",
        source_root: normalizedSourceRoot ?? "",
        scope: normalizedScope,
        writeback: rawWorkspace?.writeback === "discard" ? "discard" : "apply",
        sandbox: normalizeSandbox(normalizedPolicy.filesystem)
      }
      : {
        kind: "ephemeral",
        topology: "direct",
        source_root: null,
        scope: { mode: "full" },
        writeback: "discard",
        sandbox: normalizeSandbox(normalizedPolicy.filesystem)
      },
    policy: normalizedPolicy,
    output: {
      format: isOneOf(rawOutput?.format, OUTPUT_FORMATS) ? rawOutput.format : "message",
      schema: normalizedOutputSchema
    },
    hints: isPlainObject(request.hints) ? request.hints : {},
    metadata: isPlainObject(request.metadata) ? request.metadata : {}
  };
}

async function validateRequest(
  request: NormalizedExecutionRequest,
  rawRequest: ExecutionRequest
): Promise<{
  issues: ValidationIssue[];
  resolvedAttachmentPaths: Array<{ index: number; path: string }>;
}> {
  const issues: ValidationIssue[] = [];
  const resolvedAttachmentPaths: Array<{ index: number; path: string }> = [];
  const rawRuntime = asRecord(rawRequest.runtime);
  const rawOutput = asRecord(rawRequest.output);
  const rawPolicy = asRecord(rawRequest.policy);
  const rawWorkspace = asRecord(rawRequest.workspace);
  const rawTask = asRecord(rawRequest.task);
  const rawSession = asRecord(rawRequest.session);
  const rawExecutionProfile = asRecord(rawRequest.execution_profile);

  if (!isOneOf(request.backend, BACKEND_NAMES)) {
    issues.push({ path: "$.backend", message: `must be one of ${BACKEND_NAMES.join(" or ")}` });
  }
  if ("execution_profile" in rawRequest && rawRequest.execution_profile !== undefined && !rawExecutionProfile) {
    issues.push({ path: "$.execution_profile", message: "must be an object when provided" });
  }
  if ("runtime" in rawRequest && rawRequest.runtime !== undefined && !rawRuntime) {
    issues.push({ path: "$.runtime", message: "must be an object when provided" });
  }
  if ("session" in rawRequest && rawRequest.session !== undefined && !rawSession) {
    issues.push({ path: "$.session", message: "must be an object when provided" });
  }
  if ("policy" in rawRequest && rawRequest.policy !== undefined && !rawPolicy) {
    issues.push({ path: "$.policy", message: "must be an object when provided" });
  }
  if ("workspace" in rawRequest && rawRequest.workspace !== undefined && !rawWorkspace) {
    issues.push({ path: "$.workspace", message: "must be an object when provided" });
  }
  if ("output" in rawRequest && rawRequest.output !== undefined && !rawOutput) {
    issues.push({ path: "$.output", message: "must be an object when provided" });
  }
  if ("capabilities" in rawRequest) {
    issues.push({ path: "$.capabilities", message: "has been removed; use policy instead" });
  }
  if (rawWorkspace && "topology" in rawWorkspace) {
    issues.push({ path: "$.workspace.topology", message: "is not a public request field; topology is derived from policy" });
  }
  if (rawWorkspace && "sandbox" in rawWorkspace) {
    issues.push({ path: "$.workspace.sandbox", message: "is not a public request field; sandbox is derived from policy" });
  }
  if (rawPolicy && "control_gates" in rawPolicy) {
    issues.push({ path: "$.policy.control_gates", message: "has been removed; use policy.approvals instead" });
  }
  if (!request.task.prompt.trim()) {
    issues.push({ path: "$.task.prompt", message: "must be a non-empty string" });
  }
  if (rawTask && "objective" in rawTask && rawTask.objective !== undefined && typeof rawTask.objective !== "string") {
    issues.push({ path: "$.task.objective", message: "must be a string when provided" });
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
  if (rawWorkspace && typeof rawWorkspace?.source_root === "string" && !path.isAbsolute(rawWorkspace.source_root)) {
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
  if (request.workspace.kind === "ephemeral" && request.policy.isolation === "require_workspace_isolation") {
    issues.push({ path: "$.policy.isolation", message: "requires a caller-provided workspace.source_root" });
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
  if (request.session.mode !== "new" && request.session.mode !== "ephemeral" && !request.session.handle) {
    issues.push({ path: "$.session.handle", message: "is required for continue and fork modes" });
  }
  if (request.session.handle && !isSafeSessionHandle(request.session.handle)) {
    issues.push({ path: "$.session.handle", message: "must be a safe opaque handle" });
  }
  if (request.execution_profile.selection_mode === "pinned" && !request.execution_profile.pin) {
    issues.push({ path: "$.execution_profile.pin", message: "is required for pinned selection_mode" });
  }
  if (request.execution_profile.selection_mode === "override" && !request.execution_profile.override) {
    issues.push({ path: "$.execution_profile.override", message: "is required for override selection_mode" });
  }
  if (rawRuntime && "timeout_ms" in rawRuntime) {
    const rawTimeoutMs = rawRuntime.timeout_ms;
    if (typeof rawTimeoutMs !== "number" || !Number.isInteger(rawTimeoutMs) || rawTimeoutMs <= 0) {
      issues.push({ path: "$.runtime.timeout_ms", message: "must be a positive integer when provided" });
    }
  }
  if (rawPolicy && "isolation" in rawPolicy && !isOneOf(rawPolicy.isolation, POLICY_ISOLATION_MODES)) {
    issues.push({ path: "$.policy.isolation", message: "must be one of default or require_workspace_isolation" });
  }
  if (rawPolicy && "approvals" in rawPolicy && !isOneOf(rawPolicy.approvals, POLICY_APPROVAL_MODES)) {
    issues.push({ path: "$.policy.approvals", message: "must be one of default or forbid_interactive_approvals" });
  }
  if (rawPolicy && "filesystem" in rawPolicy && !isOneOf(rawPolicy.filesystem, POLICY_FILESYSTEM_MODES)) {
    issues.push({ path: "$.policy.filesystem", message: "must be one of default, read_only, workspace_write, or full_access" });
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

function isOneOf<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === "string" && allowed.includes(value as T[number]);
}

function normalizeTimeoutMs(value: unknown, performanceTier: typeof PERFORMANCE_TIERS[number]): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  return resolveDefaultExecutionTimeoutMs(performanceTier);
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

function applyResolvedAttachmentPaths(
  request: NormalizedExecutionRequest,
  resolvedAttachmentPaths: Array<{ index: number; path: string }>
): NormalizedExecutionRequest {
  if (resolvedAttachmentPaths.length === 0) {
    return request;
  }
  const attachments = request.task.attachments.slice();
  for (const resolved of resolvedAttachmentPaths) {
    const attachment = attachments[resolved.index];
    if (!attachment || attachment.kind !== "path") {
      continue;
    }
    attachments[resolved.index] = {
      ...attachment,
      path: resolved.path
    };
  }
  return {
    ...request,
    task: {
      ...request.task,
      attachments
    }
  };
}

function normalizeSandbox(filesystem: ExecutionPolicy["filesystem"]): "read-only" | "workspace-write" | "danger-full-access" {
  switch (filesystem) {
    case "read_only":
    case "default":
      return "read-only";
    case "full_access":
      return "danger-full-access";
    case "workspace_write":
      return "workspace-write";
  }
  throw new Error(`Unsupported policy.filesystem value: ${String(filesystem)}`);
}
