import { asRecord } from "../utils.ts";
import { resolvePromptAttachments } from "../engine/prompt-attachments.ts";
import { streamCommand } from "./process.ts";
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
      yield {
        type: "provider.failed",
        error: {
          command: input.command,
          reason: event.reason,
          exit_code: event.exitCode,
          stdout,
          stderr,
          interrupted_by: interruptedBy,
        }
      };
      return;
    }
  }

  const translated = await input.parser.finish({
    stdout,
    stderr
  });

  if (translated.debug) {
    yield { type: "provider.debug", debug: translated.debug };
  }

  yield {
    type: "provider.completed",
    result: {
      continuation: translated.continuation_token
        ? { backend: input.context.request.backend, token: translated.continuation_token }
        : input.context.continuation,
      raw_output_text: translated.raw_output_text,
      usage: translated.usage,
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
  // Append by default: keep Claude Code's built-in tool/safety guidance and add caller
  // context. Replacing the whole prompt drops that guidance — doubly unsafe under the
  // permissive permission mode bo_staff runs. `replace` is opt-in for non-coding pipelines.
  const systemPromptFlag = context.request.system_prompt_mode === "replace"
    ? "--system-prompt"
    : "--append-system-prompt";
  return {
    stdin_text: userSections.join("\n\n"),
    extra_args: systemText ? [systemPromptFlag, systemText] : undefined
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

function resolveAbortReason(signal: AbortSignal): string | undefined {
  const reason = signal.reason;
  return typeof reason === "string" && reason.length > 0 ? reason : undefined;
}
