import type {
  ExecutionRequest,
  NormalizedExecutionRequest,
  ValidationIssue,
  ValidationResult
} from "./types.ts";
import { isPlainObject } from "./utils.ts";
import { normalizeRequest } from "./validation/normalize.ts";
import { KNOWN_TOP_LEVEL_FIELDS, applyResolvedAttachmentPaths } from "./validation/shared.ts";
import { validateRequest } from "./validation/validate.ts";

export async function normalizeAndValidateRequest(request: unknown): Promise<ValidationResult<NormalizedExecutionRequest>> {
  if (!isPlainObject(request)) {
    return { ok: false, issues: [{ path: "$", message: "request must be an object" }] };
  }

  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(request)) {
    if (!KNOWN_TOP_LEVEL_FIELDS.has(key)) {
      issues.push({ path: `$.${key}`, message: "is not a supported top-level request field" });
    }
  }

  // request is validated as a plain object above; cast to typed view for normalization.
  // We pass both the typed view and the raw record to validateRequest so that
  // fields not on the ExecutionRequest type (e.g. lease, removed legacy fields) can be
  // checked without unsafe casts.
  const rawRecord = request;
  const executionRequest = request as unknown as ExecutionRequest;
  const normalized = normalizeRequest(executionRequest);
  const validation = await validateRequest(normalized, executionRequest, rawRecord);
  issues.push(...validation.issues);
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: applyResolvedAttachmentPaths(normalized, validation.resolvedAttachmentPaths),
    issues: []
  };
}
