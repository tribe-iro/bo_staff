import { resolveDefaultExecutionTimeoutMs } from "../config/defaults.ts";
import type { NormalizedExecutionRequest } from "../types.ts";

export const KNOWN_TOP_LEVEL_FIELDS = new Set([
  "backend",
  "execution_profile",
  "runtime",
  "task",
  "continuation",
  "workspace",
  "policy",
  "output",
  "tool_configuration",
  "metadata",
  "lease",
]);

export interface ResolvedAttachmentPath {
  index: number;
  path: string;
}

export function isOneOf<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === "string" && allowed.includes(value as T[number]);
}

export function isValidUrlString(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

const MIME_TOKEN_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+$/;

export function isValidMimeType(value: string): boolean {
  const parts = value.split("/");
  if (parts.length !== 2) {
    return false;
  }
  const [type, subtype] = parts;
  return MIME_TOKEN_PATTERN.test(type ?? "")
    && MIME_TOKEN_PATTERN.test(subtype ?? "");
}

export function normalizeTimeoutMs(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  return resolveDefaultExecutionTimeoutMs();
}

export function applyResolvedAttachmentPaths(
  request: NormalizedExecutionRequest,
  resolvedAttachmentPaths: ResolvedAttachmentPath[]
): NormalizedExecutionRequest {
  if (resolvedAttachmentPaths.length === 0) {
    return request;
  }
  const replacements = new Map(resolvedAttachmentPaths.map((entry) => [entry.index, entry.path]));
  return {
    ...request,
    task: {
      ...request.task,
      attachments: request.task.attachments.map((attachment, index) => {
        if (attachment.kind !== "path" || !replacements.has(index)) {
          return attachment;
        }
        return {
          ...attachment,
          path: replacements.get(index) ?? attachment.path
        };
      })
    }
  };
}
