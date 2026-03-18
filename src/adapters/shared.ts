import { streamCommand } from "./process.ts";
import { UpstreamRuntimeError } from "../errors.ts";
import { classifyUpstreamErrorKind } from "../providers/shared.ts";
import { extractJsonObject, extractSingleEmbeddedFencedJsonObjectText } from "../json/extract.ts";
import type { AdapterEvent, AdapterExecutionContext } from "./types.ts";
import type { UsageSummary } from "../types.ts";

export async function* executeCliAdapter(input: {
  context: AdapterExecutionContext;
  command: string;
  args: string[];
  initial_provider_session_id?: string;
  translate: (value: {
    context: AdapterExecutionContext;
    stdout: string;
    stderr: string;
  }) => Promise<{
    provider_session_id?: string;
    raw_output_text?: string;
    usage?: UsageSummary;
    debug?: Record<string, unknown>;
  }> | {
    provider_session_id?: string;
    raw_output_text?: string;
    usage?: UsageSummary;
    debug?: Record<string, unknown>;
  };
}): AsyncIterable<AdapterEvent> {
  let stdout = "";
  let stderr = "";

  yield { type: "provider.started", provider_session_id: input.initial_provider_session_id };

  for await (const event of streamCommand({
    command: input.command,
    args: input.args,
    cwd: input.context.workspace.runtime_working_directory,
    env: undefined,
    timeoutMs: input.context.request.runtime.timeout_ms,
    stdinText: input.context.prompt,
    signal: input.context.signal
  })) {
    if (event.type === "stdout") {
      stdout += event.text;
      yield { type: "provider.output.chunk", text: event.text };
      continue;
    }
    if (event.type === "stderr") {
      stderr += event.text;
      continue;
    }
    if (event.reason !== "exited" || event.exitCode !== 0) {
      throw new UpstreamRuntimeError(
        buildTerminationMessage(input.command, event.reason, event.exitCode, stderr || stdout),
        502,
        classifyUpstreamErrorKind(`${stderr}\n${stdout}`)
      );
    }
  }

  const translated = await input.translate({
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
      provider_session_id: translated.provider_session_id,
      raw_output_text: translated.raw_output_text,
      usage: translated.usage,
      exit_reason: "completed",
      debug: translated.debug
    }
  };
}

function buildTerminationMessage(
  command: string,
  reason: "exited" | "timed_out" | "stdout_overflow" | "stderr_overflow" | "aborted",
  exitCode: number | null,
  output: string
): string {
  if (reason === "aborted") {
    return `Command aborted: ${command}`;
  }
  if (reason === "timed_out") {
    return `Command timed out: ${command}`;
  }
  if (reason === "stdout_overflow" || reason === "stderr_overflow") {
    return `Command ${reason === "stdout_overflow" ? "stdout" : "stderr"} exceeded output budget: ${command}`;
  }
  return `${command} exited with code ${exitCode ?? 1}: ${output}`;
}

export function normalizeProviderResultText(rawText: string): string {
  try {
    extractJsonObject(rawText);
    return rawText.trim();
  } catch {
    return extractSingleEmbeddedFencedJsonObjectText(rawText) ?? rawText.trim();
  }
}
