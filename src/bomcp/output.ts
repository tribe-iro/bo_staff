import { createHash } from "node:crypto";
import type { BomcpEnvelope } from "./types.ts";
import { extractJsonObject } from "../json/extract.ts";
import type {
  ArtifactRecord,
  ValidationIssue
} from "../types.ts";
import { asRecord } from "../utils.ts";

export interface CompactOutputCandidate {
  summary: string;
  payload: unknown;
  pending_items: string[];
  artifacts: ArtifactRecord[];
}

export type OutputContractStatus = "valid" | "invalid" | "missing";

export function parseCompactOutput(input: {
  raw_text: string;
}): {
  status: OutputContractStatus;
  value?: CompactOutputCandidate;
  issues: ValidationIssue[];
} {
  if (!input.raw_text.trim()) {
    return {
      status: "missing",
      issues: [{ path: "$", message: "provider output was missing" }]
    };
  }

  try {
    const parsed = extractJsonObject(input.raw_text);
    const candidate = validateCompactCandidate(parsed);
    if (candidate) {
      return {
        status: "valid",
        value: candidate,
        issues: []
      };
    }
  } catch {
    // handled below
  }

  return {
    status: "invalid",
    issues: [{ path: "$", message: "provider output did not contain valid bo_staff compact JSON" }]
  };
}

/**
 * Extract the agent's structured output from a terminal envelope.
 * The agent output lives inside payload.output as a JSON string in the compact format:
 * { summary: "...", payload: { content: "...", ...custom fields }, pending_items: [], artifacts: [] }
 * Returns the inner payload object (the structured output the caller cares about).
 */
export function extractAgentOutput(envelope: BomcpEnvelope): Record<string, unknown> | undefined {
  const payload = asRecord(envelope.payload);
  if (!payload) return undefined;

  // Already has structured fields directly (unlikely but handle it)
  if (payload.content !== undefined && typeof payload.output !== "string") return payload;

  // Parse from payload.output JSON string
  if (typeof payload.output === "string") {
    const parsed = parseCompactOutput({ raw_text: payload.output });
    const inner = asRecord(parsed.value?.payload);
    if (inner) return inner;
    try {
      const direct = JSON.parse(payload.output);
      if (typeof direct === "object" && direct !== null) return direct as Record<string, unknown>;
    } catch { /* not JSON */ }
  }

  // Parsed output object
  const output = asRecord(payload.output);
  if (output) {
    const inner = asRecord(output.payload);
    if (inner) return inner;
    return output;
  }

  return undefined;
}

/**
 * Extract the agent's text content from a terminal envelope.
 * Looks for content in the agent compact JSON output format, falling back to summary.
 */
export function extractAgentContent(envelope: BomcpEnvelope): string | undefined {
  const payload = asRecord(envelope.payload);
  if (!payload) return undefined;

  // Direct content field
  if (typeof payload.content === "string") return payload.content;

  // Content inside raw output JSON (agent compact output format)
  if (typeof payload.output === "string") {
    const parsed = parseCompactOutput({ raw_text: payload.output });
    if (typeof parsed.value?.payload === "object" && parsed.value?.payload !== null) {
      const inner = asRecord(parsed.value.payload);
      if (typeof inner?.content === "string") return inner.content;
    }
    if (typeof parsed.value?.summary === "string") return parsed.value.summary;
    return payload.output;
  }

  // Content inside parsed output object
  const output = asRecord(payload.output);
  if (output) {
    const inner = asRecord(output.payload);
    if (typeof inner?.content === "string") return inner.content;
    if (typeof output.summary === "string") return output.summary;
  }

  return undefined;
}

function validateCompactCandidate(value: unknown): CompactOutputCandidate | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  if (typeof record.summary !== "string") {
    return undefined;
  }
  const pendingItems = Array.isArray(record.pending_items)
    ? record.pending_items.filter((item): item is string => typeof item === "string")
    : [];
  const artifacts = Array.isArray(record.artifacts)
    ? record.artifacts.flatMap(parseArtifact)
    : [];
  return {
    summary: record.summary,
    payload: record.payload,
    pending_items: pendingItems,
    artifacts
  };
}

function parseArtifact(value: unknown): ArtifactRecord[] {
  const record = asRecord(value);
  if (!record || typeof record.kind !== "string") {
    return [];
  }
  const normalizedArtifact: ArtifactRecord = {
    artifact_id: typeof record.artifact_id === "string" ? record.artifact_id : buildSyntheticArtifactId(record),
    kind: record.kind,
    path: typeof record.path === "string" ? record.path : undefined,
    description: typeof record.description === "string" ? record.description : undefined,
    provenance: record.provenance === "backend" || record.provenance === "caller" ? record.provenance : "framework",
    materialization_state:
      record.materialization_state === "materialized" || record.materialization_state === "missing"
        ? record.materialization_state
        : "cataloged"
  };
  return [normalizedArtifact];
}

function buildSyntheticArtifactId(record: Record<string, unknown>): string {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({
      kind: record.kind,
      path: typeof record.path === "string" ? record.path : null,
      description: typeof record.description === "string" ? record.description : null,
      provenance: record.provenance === "backend" || record.provenance === "caller" ? record.provenance : "framework",
      materialization_state:
        record.materialization_state === "materialized" || record.materialization_state === "missing"
          ? record.materialization_state
          : "cataloged"
    }))
    .digest("hex");
  return `artifact_auto_${fingerprint.slice(0, 24)}`;
}
