import { DEFAULT_MESSAGE_OUTPUT_SCHEMA } from "../config/defaults.ts";
import { buildExecutionError } from "../errors/taxonomy.ts";
import { asRecord, stableJson } from "../utils.ts";
import { resolvePromptAttachments } from "../engine/prompt-attachments.ts";
import { streamCommand } from "./process.ts";
import { classifyUpstreamErrorKind } from "../providers/shared.ts";
import {
  extractJsonObject,
  extractJsonObjectText,
  extractSingleEmbeddedFencedJsonObjectText
} from "../json/extract.ts";
import type {
  AdapterEvent,
  AdapterExecutionContext,
  ProviderEventParser,
  RenderedPrompt
} from "./types.ts";

export async function* executeCliAdapter(input: {
  context: AdapterExecutionContext;
  command: string;
  args: string[];
  rendered_prompt: RenderedPrompt;
  initial_provider_session_id?: string;
  parser: ProviderEventParser;
}): AsyncIterable<AdapterEvent> {
  let stdout = "";
  let stderr = "";

  yield { type: "provider.started", provider_session_id: input.initial_provider_session_id };

  for await (const event of streamCommand({
    command: input.command,
    args: [...(input.rendered_prompt.extra_args ?? []), ...input.args],
    cwd: input.context.workspace.runtime_working_directory,
    env: undefined,
    timeoutMs: input.context.request.runtime.timeout_ms,
    stdinText: input.rendered_prompt.stdin_text,
    signal: input.context.signal
  })) {
    if (event.type === "stdout") {
      stdout += event.text;
      yield { type: "provider.output.chunk", text: event.text };
      for (const parsedEvent of input.parser.onStdoutChunk(event.text)) {
        yield parsedEvent;
      }
      continue;
    }
    if (event.type === "stderr") {
      stderr += event.text;
      for (const parsedEvent of input.parser.onStderrChunk(event.text)) {
        yield parsedEvent;
      }
      continue;
    }
    if (event.reason !== "exited" || event.exitCode !== 0) {
      const interruptedBy = resolveAbortReason(input.context.signal);
      const kind = classifyTerminationFailureKind({
        reason: event.reason,
        combinedOutput: `${stderr}\n${stdout}`,
        interruptedBy
      });
      yield {
        type: "provider.failed",
        error: {
          message: buildTerminationMessage({
            command: input.command,
            reason: event.reason,
            exitCode: event.exitCode,
            stdout,
            stderr
          }),
          retryable: buildExecutionError(kind, "").retryable,
          kind,
          debug: buildTerminationDebug({
            command: input.command,
            reason: event.reason,
            exitCode: event.exitCode,
            stdout,
            stderr,
            interruptedBy
          }),
          details: {
            termination_reason: event.reason,
            interruption_source: interruptedBy
          }
        }
      };
      return;
    }
  }

  const translated = await input.parser.finish({
    context: input.context,
    stdout,
    stderr
  });

  if (translated.debug) {
    yield { type: "provider.debug", debug: translated.debug };
  }

  yield {
    type: "provider.completed",
    result: {
      continuation: translated.continuation,
      raw_output_text: translated.raw_output_text,
      usage: translated.usage,
      schema_enforcement_applied: translated.schema_enforcement_applied,
      tool_configuration_outcome: translated.tool_configuration_outcome,
      exit_reason: "completed",
      debug: translated.debug
    }
  };
}

export async function renderClaudePrompt(context: AdapterExecutionContext): Promise<RenderedPrompt> {
  const systemText = context.prompt.system.sections.map((section) => section.content).filter(Boolean).join("\n\n");
  const attachmentBlocks = await resolvePromptAttachments(context.prompt.user.attachments);
  const userSections = context.prompt.user.sections.map((section) => section.content).filter(Boolean);
  if (attachmentBlocks.length > 0) {
    userSections.push(`Attachments:\n${attachmentBlocks.map((attachment) => `${attachment.label}:\n${attachment.content}`).join("\n\n")}`);
  }
  return {
    stdin_text: userSections.join("\n\n"),
    extra_args: systemText ? ["--system-prompt", systemText] : undefined
  };
}

export async function renderCodexPrompt(context: AdapterExecutionContext): Promise<RenderedPrompt> {
  const systemText = context.prompt.system.sections.map((section) => section.content).filter(Boolean).join("\n\n");
  const attachmentBlocks = await resolvePromptAttachments(context.prompt.user.attachments);
  const userSections = context.prompt.user.sections.map((section) => section.content).filter(Boolean);
  if (attachmentBlocks.length > 0) {
    userSections.push(`Attachments:\n${attachmentBlocks.map((attachment) => `${attachment.label}:\n${attachment.content}`).join("\n\n")}`);
  }
  const chunks = [
    systemText ? `=== SYSTEM CONTEXT ===\n${systemText}` : "",
    userSections.length > 0 ? `=== USER TASK ===\n${userSections.join("\n\n")}` : ""
  ].filter(Boolean);
  return {
    stdin_text: chunks.join("\n\n")
  };
}

export function extractStructuredProviderResultText(input: {
  structured_output: unknown;
  raw_result: unknown;
}): string {
  const structuredOutput = asRecord(input.structured_output);
  if (structuredOutput) {
    const keys = Object.keys(structuredOutput);
    if (keys.length === 1 && typeof structuredOutput.content === "string") {
      return structuredOutput.content;
    }
    return JSON.stringify(structuredOutput);
  }
  if (typeof input.raw_result === "string") {
    return input.raw_result;
  }
  if (input.raw_result !== undefined) {
    return JSON.stringify(input.raw_result);
  }
  return "";
}

export function canonicalizeProviderResultText(input: {
  context: AdapterExecutionContext;
  raw_text: string;
}): string {
  const normalizedRaw = normalizeProviderResultText(input.raw_text);
  if (!normalizedRaw) {
    return normalizedRaw;
  }
  if (shouldWrapRawTextAsMessagePayload(input.context)) {
    return wrapRawTextAsMessagePayload(normalizedRaw) ?? normalizedRaw;
  }
  if (input.context.request.output.format === "custom") {
    const wrapped = wrapRawTextAsCustomPayload(normalizedRaw);
    if (wrapped) {
      return wrapped;
    }
  }
  return normalizedRaw;
}

function buildTerminationMessage(input: {
  command: string;
  reason: "exited" | "timed_out" | "stdout_overflow" | "stderr_overflow" | "aborted";
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): string {
  const detail = summarizeFailureOutput({
    stdout: input.stdout,
    stderr: input.stderr,
    combinedOutput: `${input.stderr}\n${input.stdout}`
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
      detail
    );
  }
  return appendFailureDetail(`${input.command} exited with code ${input.exitCode ?? 1}`, detail);
}

function buildTerminationDebug(input: {
  command: string;
  reason: "exited" | "timed_out" | "stdout_overflow" | "stderr_overflow" | "aborted";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  interruptedBy?: string;
}): Record<string, unknown> {
  return {
    command: input.command,
    termination_reason: input.reason,
    exit_code: input.exitCode,
    output_excerpt: summarizeFailureOutput({
      stdout: input.stdout,
      stderr: input.stderr,
      combinedOutput: input.stderr || input.stdout
    }),
    stdout_tail: tailText(input.stdout),
    stderr_tail: tailText(input.stderr),
    interruption_source: input.interruptedBy
  };
}

function summarizeFailureOutput(input: {
  stdout?: string;
  stderr?: string;
  combinedOutput: string;
}): string | undefined {
  const candidates = [
    ...extractFailureCandidates(input.stdout, "stdout"),
    ...extractFailureCandidates(input.stderr, "stderr")
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
  source: "stdout" | "stderr"
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
    pending_items: []
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
      artifacts: []
    });
  } catch {
    return undefined;
  }
}

export function shouldWrapRawTextAsMessagePayload(context: AdapterExecutionContext): boolean {
  return context.request.output.format === "message"
    && stableJson(context.request.output.schema) === stableJson(DEFAULT_MESSAGE_OUTPUT_SCHEMA);
}

function looksLikeCompactResult(rawText: string): boolean {
  try {
    const parsed = extractJsonObject(rawText) as Record<string, unknown>;
    return typeof parsed.summary === "string" && "payload" in parsed && Array.isArray(parsed.pending_items);
  } catch {
    return false;
  }
}

function resolveAbortReason(signal: AbortSignal): string | undefined {
  const reason = signal.reason;
  return typeof reason === "string" && reason.length > 0 ? reason : undefined;
}

export function classifyTerminationFailureKind(input: {
  reason: "exited" | "timed_out" | "stdout_overflow" | "stderr_overflow" | "aborted";
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
