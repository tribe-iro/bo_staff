import { DEFAULT_MESSAGE_OUTPUT_SCHEMA } from "../config/defaults.ts";
import { buildExecutionError } from "../errors/taxonomy.ts";
import {
  extractJsonObject,
  extractJsonObjectText,
  extractSingleEmbeddedFencedJsonObjectText,
} from "../json/extract.ts";
import { parseCompactOutput } from "../bomcp/output.ts";
import { validateAgainstSchema } from "../schema/validator.ts";
import { stableJson } from "../utils.ts";
import type { ProviderFailure } from "../adapters/types.ts";
import type { ExecutionError, NormalizedExecutionRequest } from "../types.ts";

export function canonicalizeProviderResultText(input: {
  request: NormalizedExecutionRequest;
  raw_text: string;
}): string {
  const normalizedRaw = normalizeProviderResultText(input.raw_text);
  if (!normalizedRaw) {
    return normalizedRaw;
  }
  if (shouldWrapRawTextAsMessagePayload(input.request)) {
    return wrapRawTextAsMessagePayload(normalizedRaw) ?? normalizedRaw;
  }
  if (input.request.output.format === "custom") {
    const wrapped = wrapRawTextAsCustomPayload(normalizedRaw);
    if (wrapped) {
      return wrapped;
    }
  }
  return normalizedRaw;
}

export function validateTerminalOutput(input: {
  request: NormalizedExecutionRequest;
  raw_output_text?: string;
}): { output?: string; error?: ExecutionError } {
  if (!input.raw_output_text?.trim()) {
    return {
      error: buildExecutionError("provider_output_missing", "provider returned no terminal output"),
    };
  }

  const canonicalOutput = canonicalizeProviderResultText({
    request: input.request,
    raw_text: input.raw_output_text,
  });
  if (!canonicalOutput.trim()) {
    return {
      error: buildExecutionError("provider_output_missing", "provider returned no terminal output"),
    };
  }

  const parsed = parseCompactOutput({ raw_text: canonicalOutput });
  if (parsed.status !== "valid" || !parsed.value) {
    return {
      error: buildExecutionError("provider_output_invalid", "provider output did not contain valid bo_staff compact JSON"),
    };
  }

  const schemaIssues = validateAgainstSchema(input.request.output.schema, parsed.value.payload, "$.payload");
  if (schemaIssues.length > 0 && input.request.output.schema_enforcement !== "advisory") {
    const summary = schemaIssues.slice(0, 3).map((issue) => `${issue.path} ${issue.message}`).join("; ");
    return {
      error: buildExecutionError(
        "schema_validation_failed",
        `provider output did not satisfy the requested schema: ${summary}`,
      ),
    };
  }

  return { output: canonicalOutput };
}

export function classifyProviderFailure(input: ProviderFailure): {
  error: ExecutionError;
  debug: Record<string, unknown>;
} {
  const kind = classifyTerminationFailureKind({
    reason: input.reason,
    combinedOutput: `${input.stderr}\n${input.stdout}`,
    interruptedBy: input.interrupted_by,
  });
  return {
    error: buildExecutionError(kind, buildTerminationMessage(input), {
      details: {
        termination_reason: input.reason,
        interruption_source: input.interrupted_by,
        exit_code: input.exit_code ?? undefined,
      },
    }),
    debug: buildTerminationDebug(input),
  };
}

export function normalizeProviderResultText(rawText: string): string {
  try {
    extractJsonObject(rawText);
    return extractJsonObjectText(rawText).trim();
  } catch {
    return extractSingleEmbeddedFencedJsonObjectText(rawText) ?? rawText.trim();
  }
}

export function wrapRawTextAsMessagePayload(rawText: string): string | undefined {
  const trimmed = rawText.trim();
  if (!trimmed || trimmed.includes("```") || looksLikeCompactResult(trimmed)) {
    return undefined;
  }
  return JSON.stringify({
    summary: trimmed,
    payload: { content: trimmed },
    pending_items: [],
  });
}

export function wrapRawTextAsCustomPayload(rawText: string): string | undefined {
  const trimmed = rawText.trim();
  if (!trimmed || looksLikeCompactResult(trimmed)) {
    return undefined;
  }
  try {
    const parsed = extractJsonObject(trimmed) as Record<string, unknown>;
    const pendingItems = Array.isArray(parsed.pending_items)
      ? parsed.pending_items.filter((item): item is string => typeof item === "string")
      : [];
    return JSON.stringify({
      summary: typeof parsed.summary === "string" ? parsed.summary : "Structured output returned.",
      payload: parsed,
      pending_items: pendingItems,
      artifacts: [],
    });
  } catch {
    return undefined;
  }
}

function shouldWrapRawTextAsMessagePayload(request: NormalizedExecutionRequest): boolean {
  return request.output.format === "message"
    && stableJson(request.output.schema) === stableJson(DEFAULT_MESSAGE_OUTPUT_SCHEMA);
}

function looksLikeCompactResult(rawText: string): boolean {
  try {
    const parsed = extractJsonObject(rawText) as Record<string, unknown>;
    return typeof parsed.summary === "string" && "payload" in parsed && Array.isArray(parsed.pending_items);
  } catch {
    return false;
  }
}

function classifyTerminationFailureKind(input: {
  reason: ProviderFailure["reason"];
  combinedOutput: string;
  interruptedBy?: string;
}) {
  if (input.reason === "aborted") {
    if (input.interruptedBy === "client_disconnect") {
      return "client_disconnect_cancelled" as const;
    }
    if (input.interruptedBy === "cancel_request") {
      return "execution_cancelled" as const;
    }
    if (input.interruptedBy === "turn_limit_exceeded") {
      return "turn_limit_exceeded" as const;
    }
    return "provider_process_aborted" as const;
  }
  if (input.reason === "timed_out") {
    return "provider_timeout" as const;
  }
  if (input.reason === "stdout_overflow" || input.reason === "stderr_overflow") {
    return "provider_output_overflow" as const;
  }
  const upstreamKind = classifyUpstreamErrorKind(input.combinedOutput);
  if (upstreamKind === "rate_limit") {
    return "provider_rate_limit" as const;
  }
  if (upstreamKind === "auth") {
    return "provider_auth_error" as const;
  }
  return "provider_process_error" as const;
}

function classifyUpstreamErrorKind(output: string): "runtime" | "rate_limit" | "auth" {
  if (/rate.?limit|429|quota/i.test(output)) {
    return "rate_limit";
  }
  if (/unauthorized|invalid.*key|401|403/i.test(output)) {
    return "auth";
  }
  return "runtime";
}

function buildTerminationMessage(input: ProviderFailure): string {
  const detail = summarizeFailureOutput({
    stdout: input.stdout,
    stderr: input.stderr,
    combinedOutput: `${input.stderr}\n${input.stdout}`,
  });
  if (input.reason === "aborted") {
    return appendFailureDetail(`Command aborted: ${input.command}`, detail);
  }
  if (input.reason === "timed_out") {
    return appendFailureDetail(`Command timed out: ${input.command}`, detail);
  }
  if (input.reason === "stdout_overflow" || input.reason === "stderr_overflow") {
    return appendFailureDetail(
      `Command ${input.reason === "stdout_overflow" ? "stdout" : "stderr"} exceeded output budget: ${input.command}`,
      detail,
    );
  }
  return appendFailureDetail(`${input.command} exited with code ${input.exit_code ?? 1}`, detail);
}

function buildTerminationDebug(input: ProviderFailure): Record<string, unknown> {
  return {
    command: input.command,
    termination_reason: input.reason,
    exit_code: input.exit_code,
    output_excerpt: summarizeFailureOutput({
      stdout: input.stdout,
      stderr: input.stderr,
      combinedOutput: input.stderr || input.stdout,
    }),
    stdout_tail: tailText(input.stdout),
    stderr_tail: tailText(input.stderr),
    interruption_source: input.interrupted_by,
  };
}

function summarizeFailureOutput(input: {
  stdout?: string;
  stderr?: string;
  combinedOutput: string;
}): string | undefined {
  const candidates = [
    ...extractFailureCandidates(input.stdout, "stdout"),
    ...extractFailureCandidates(input.stderr, "stderr"),
  ];
  const best = candidates
    .sort((left, right) => right.score - left.score || right.index - left.index)[0];
  if (best) {
    return trimForSummary(best.text);
  }
  const fallback = collapseWhitespace(input.combinedOutput);
  return fallback ? trimForSummary(fallback) : undefined;
}

function extractFailureCandidates(
  streamText: string | undefined,
  source: "stdout" | "stderr",
): Array<{ text: string; score: number; index: number }> {
  if (!streamText) {
    return [];
  }
  const lines = streamText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.flatMap((line, index) => {
    const structured = extractStructuredFailureMessage(line);
    const text = structured ?? line;
    const score = scoreFailureCandidate(text, structured !== undefined, source);
    return score > 0 ? [{ text, score, index }] : [];
  });
}

function extractStructuredFailureMessage(line: string): string | undefined {
  if (!line.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.message === "string") {
      return record.message;
    }
    const error = record.error;
    if (error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string") {
      return (error as Record<string, unknown>).message as string;
    }
    const item = record.item;
    if (item && typeof item === "object") {
      const itemRecord = item as Record<string, unknown>;
      if (typeof itemRecord.message === "string") {
        return itemRecord.message;
      }
      if (typeof itemRecord.text === "string") {
        return itemRecord.text;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function scoreFailureCandidate(text: string, structured: boolean, source: "stdout" | "stderr"): number {
  if (!text) {
    return 0;
  }
  if (/^reading prompt from stdin\.?$/i.test(text)) {
    return 0;
  }
  if (/experimentalwarning|warning: proceeding/i.test(text)) {
    return 0;
  }
  let score = structured ? 3 : 1;
  if (source === "stderr") {
    score += 2;
  }
  if (/error|failed|failure|disconnected|timed out|timeout|denied|unauthorized|rate.?limit|quota|aborted|refused|could not/i.test(text)) {
    score += 5;
  }
  return score;
}

function trimForSummary(value: string, maxChars = 280): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 3)}...` : value;
}

function appendFailureDetail(base: string, detail: string | undefined): string {
  return detail ? `${base}: ${detail}` : base;
}

function tailText(value: string, maxChars = 4000): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length > maxChars ? value.slice(-maxChars) : value;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
