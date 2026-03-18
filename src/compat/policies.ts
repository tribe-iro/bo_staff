import { createHash } from "node:crypto";
import { DEFAULT_MESSAGE_OUTPUT_SCHEMA } from "../config/defaults.ts";
import { extractJsonObject } from "../json/extract.ts";
import { asRecord, stableJson } from "../utils.ts";
import { validateAgainstSchema } from "../schema/validator.ts";
import type {
  ArtifactRecord,
  JsonSchema,
  ValidationIssue
} from "../types.ts";

export interface CompactOutputCandidate {
  summary: string;
  payload: unknown;
  pending_items: string[];
  artifacts: ArtifactRecord[];
}

export type OutputContractStatus = "valid" | "invalid" | "missing";

export function parseCompactOutput(input: {
  raw_text: string;
  payload_schema: JsonSchema;
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
    const candidate = validateCompactCandidate(parsed, input.payload_schema);
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

  const defaultMessageCandidate = buildDefaultMessageCandidate(input.raw_text, input.payload_schema);
  if (defaultMessageCandidate) {
    return {
      status: "valid",
      value: defaultMessageCandidate,
      issues: []
    };
  }

  return {
    status: "invalid",
    issues: [{ path: "$", message: "provider output did not contain valid bo_staff compact JSON" }]
  };
}

function validateCompactCandidate(value: unknown, payloadSchema: JsonSchema): CompactOutputCandidate | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  if (typeof record.summary !== "string") {
    return undefined;
  }
  const payloadIssues = validateAgainstSchema(payloadSchema, record.payload);
  if (payloadIssues.length > 0) {
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

function buildDefaultMessageCandidate(rawText: string, payloadSchema: JsonSchema): CompactOutputCandidate | undefined {
  const trimmed = rawText.trim();
  if (!trimmed || trimmed.includes("```") || stableJson(payloadSchema) !== stableJson(DEFAULT_MESSAGE_OUTPUT_SCHEMA)) {
    return undefined;
  }
  const payload = { content: trimmed };
  if (validateAgainstSchema(payloadSchema, payload).length > 0) {
    return undefined;
  }
  return {
    summary: trimmed,
    payload,
    pending_items: [],
    artifacts: []
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
    .update(stableJson({
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
