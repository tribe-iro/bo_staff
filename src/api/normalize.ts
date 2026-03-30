import * as path from "node:path";
import type { BackendName } from "../types/api.ts";
import type { NormalizedExecutionRequest } from "../types.ts";
import type { ValidationIssue } from "../types/schema.ts";
import { normalizeAndValidateRequest } from "../validation.ts";
import { expandToolNames } from "./tool-names.ts";
import { autoSelectBackend, defaultModelForBackend } from "./backend-detect.ts";
import { asRecord } from "../utils.ts";

type Layer = 0 | 1 | 2;

export interface LayeredNormalizeResult {
  ok: true;
  request: NormalizedExecutionRequest;
  lease?: { allowed_tools?: string[]; timeout_seconds?: number };
  stream: boolean;
  verbose: boolean;
  layer: Layer;
}

export interface LayeredNormalizeError {
  ok: false;
  issues: ValidationIssue[];
}

export async function normalizeLayeredRequest(
  raw: unknown,
): Promise<LayeredNormalizeResult | LayeredNormalizeError> {
  const obj = asRecord(raw);
  if (!obj) {
    return { ok: false, issues: [{ path: "$", message: "request must be a JSON object" }] };
  }

  const layer = detectLayer(obj);

  // Layer 2: pass through to existing validator
  if (layer === 2) {
    const result = await normalizeAndValidateRequest(raw);
    if (!result.ok) {
      return { ok: false, issues: result.issues };
    }
    const lease = asRecord(obj.lease) as { allowed_tools?: string[]; timeout_seconds?: number } | undefined;
    return {
      ok: true,
      request: result.value,
      lease: lease ?? undefined,
      stream: obj.stream !== false, // Layer 2 defaults to streaming
      verbose: obj.verbose === true,
      layer: 2,
    };
  }

  // Layer 0/1: translate to Layer 2 shape, then validate
  const issues: ValidationIssue[] = [];

  // Backend
  let backend: BackendName;
  if (typeof obj.backend === "string") {
    backend = obj.backend as BackendName;
  } else {
    const continuation = asRecord(obj.continuation);
    if (continuation && typeof continuation.backend === "string") {
      backend = continuation.backend as BackendName;
    } else {
      const detected = await autoSelectBackend();
      if ("error" in detected) {
        return { ok: false, issues: [{ path: "$.backend", message: detected.error }] };
      }
      backend = detected.backend;
    }
  }

  // Model
  const model = typeof obj.model === "string"
    ? obj.model
    : defaultModelForBackend(backend);

  // Workspace
  const rawWorkspace = typeof obj.workspace === "string" ? obj.workspace : undefined;
  const sourceRoot = rawWorkspace ? path.resolve(rawWorkspace) : undefined;

  if ("sandbox" in obj) {
    issues.push({
      path: "$.sandbox",
      message: "has been removed; bo_staff no longer creates git-backed sandboxes"
    });
  }

  // Tools / Lease — auto-configured; only build a lease if tools or timeout are explicitly set
  let lease: { allowed_tools?: string[]; timeout_seconds?: number } | undefined;
  if (obj.tools !== undefined) {
    const rawTools = Array.isArray(obj.tools) ? obj.tools as string[] : [String(obj.tools)];
    const expanded = expandToolNames(rawTools);
    if (expanded.errors.length > 0) {
      for (const err of expanded.errors) {
        issues.push({ path: "$.tools", message: err });
      }
    }
    lease = { allowed_tools: expanded.tools };
  }
  const timeout = typeof obj.timeout === "number" ? obj.timeout : undefined;
  if (timeout !== undefined) {
    if (timeout <= 0) {
      issues.push({ path: "$.timeout", message: "must be a positive number" });
    } else {
      lease = { ...lease, timeout_seconds: timeout };
    }
  }

  // Reasoning
  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning : undefined;

  // Stream mode
  const stream = obj.stream === true;

  // Verbose mode (include envelopes in sync response)
  const verbose = obj.verbose === true;

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  // Build Layer 2 request shape
  const layer2Request: Record<string, unknown> = {
    backend,
    execution_profile: {
      model,
      ...(reasoning ? { reasoning_effort: reasoning } : {}),
    },
    task: {
      prompt: String(obj.prompt ?? ""),
      ...(typeof obj.objective === "string" ? { objective: obj.objective } : {}),
      ...(Array.isArray(obj.constraints) ? { constraints: obj.constraints } : {}),
      ...(obj.context !== undefined ? { context: obj.context } : {}),
      ...(Array.isArray(obj.attachments) ? { attachments: obj.attachments } : {}),
    },
    ...(obj.continuation !== undefined ? { continuation: obj.continuation } : {}),
    ...(sourceRoot ? {
      workspace: { source_root: sourceRoot },
    } : {}),
    ...(typeof obj.runtime_timeout_ms === "number" ? { runtime: { timeout_ms: obj.runtime_timeout_ms } } : {}),
    ...(obj.output !== undefined ? { output: obj.output } : {}),
    ...(obj.tool_configuration !== undefined ? { tool_configuration: obj.tool_configuration } : {}),
    ...(obj.metadata !== undefined ? { metadata: obj.metadata } : {}),
  };

  const result = await normalizeAndValidateRequest(layer2Request);
  if (!result.ok) {
    return { ok: false, issues: result.issues };
  }

  return {
    ok: true,
    request: result.value,
    lease,
    stream,
    verbose,
    layer,
  };
}

function detectLayer(obj: Record<string, unknown>): Layer {
  const hasTopLevelPrompt = typeof obj.prompt === "string";
  const hasTaskPrompt = asRecord(obj.task) && typeof (asRecord(obj.task) as Record<string, unknown>)?.prompt === "string";
  const hasExecutionProfile = obj.execution_profile !== undefined;

  // Ambiguity check
  if (hasTopLevelPrompt && (hasTaskPrompt || hasExecutionProfile)) {
    // Could be ambiguous, but we'll prefer Layer 0/1 if prompt is at top level
    // and let Layer 2 fields be ignored (the normalizer won't pass them through)
  }

  if (hasTaskPrompt || hasExecutionProfile) {
    return 2;
  }

  if (hasTopLevelPrompt) {
    // Layer 0 vs 1: if any Layer 1 knobs are present, it's Layer 1
    const layer1Fields = ["model", "sandbox", "tools", "timeout", "reasoning", "objective", "constraints"];
    for (const field of layer1Fields) {
      if (obj[field] !== undefined) return 1;
    }
    return 0;
  }

  // Default to Layer 2 (will fail validation if required fields are missing)
  return 2;
}
