import { asRecord } from "../../utils.ts";
import {
  type AdapterEvent,
  type AdapterExecutionSummary,
  type ProviderEventParser
} from "../types.ts";
import type { UsageSummary } from "../../types.ts";
import { NdjsonLineBuffer, parseJsonObject, parseJsonObjectLines } from "../ndjson.ts";
import { extractStructuredProviderResultText } from "../shared.ts";

// Parser for `claude -p --output-format stream-json --verbose`: a newline-delimited stream
// of message objects (`system`/`assistant`/`user`/`result`, plus `stream_event` when partial
// messages are enabled). We project the live events into AdapterEvents and extract the final
// summary from the terminal `result` object. Disjoint from the Codex vocabulary by design —
// only the NDJSON framing is shared (see ../ndjson.ts).
export class ClaudeEventParser implements ProviderEventParser {
  private readonly lines = new NdjsonLineBuffer();
  private turnCount = 0;

  onStdoutChunk(text: string): AdapterEvent[] {
    return this.lines.push(text).flatMap((line) => this.projectLine(line));
  }

  onStderrChunk(_text: string): AdapterEvent[] {
    // With stream-json, all meaningful events arrive on stdout; stderr is debug noise.
    return [];
  }

  finish(input: { stdout: string; stderr: string }): AdapterExecutionSummary {
    const events = parseJsonObjectLines(input.stdout);
    const resultEvent = [...events].reverse().find((entry) => entry.type === "result");

    const rawText = resultEvent
      ? extractStructuredProviderResultText({
        structured_output: resultEvent.structured_output,
        raw_result: resultEvent.result,
      })
      : lastAssistantText(events);

    const usage = asRecord(resultEvent?.usage);
    const usageSummary: UsageSummary = {
      duration_ms: numberOrUndefined(resultEvent?.duration_ms),
      input_tokens: numberOrUndefined(usage?.input_tokens),
      output_tokens: numberOrUndefined(usage?.output_tokens),
      cache_read_tokens: numberOrUndefined(usage?.cache_read_input_tokens),
      cache_creation_tokens: numberOrUndefined(usage?.cache_creation_input_tokens),
      turns: numberOrUndefined(resultEvent?.num_turns),
    };

    return {
      continuation_token: typeof resultEvent?.session_id === "string" ? resultEvent.session_id : undefined,
      raw_output_text: rawText,
      usage: Object.values(usageSummary).some((value) => value !== undefined) ? usageSummary : undefined,
      debug: {
        provider_result_text: rawText,
        stdout: input.stdout,
        stderr: input.stderr,
      },
    };
  }

  private projectLine(line: string): AdapterEvent[] {
    const record = parseJsonObject(line);
    if (!record) {
      return [];
    }
    const type = typeof record.type === "string" ? record.type : "unknown";

    switch (type) {
      case "system":
        return [progress("Claude session initialized.", "session", type)];
      case "assistant":
        return this.projectAssistant(record, type);
      case "user":
        return [progress("Tool result received.", "tool", type)];
      case "result":
        // Terminal object — surfaced by finish(); nothing live to emit.
        return [];
      case "stream_event":
        // Partial-message deltas (opt-in firehose). bo_staff's stream is control, not a token relay.
        return [];
      default:
        // Defensive: unknown event types pass through as generic progress, never throw.
        return [progress(`Claude event: ${type}`, "provider", type)];
    }
  }

  private projectAssistant(record: Record<string, unknown>, type: string): AdapterEvent[] {
    this.turnCount += 1;
    const events: AdapterEvent[] = [{ type: "provider.turn_boundary", turn_number: this.turnCount }];
    const message = asRecord(record.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const rawBlock of content) {
      const block = asRecord(rawBlock);
      const blockType = typeof block?.type === "string" ? block.type : "";
      if (blockType === "thinking" && typeof block?.thinking === "string") {
        events.push(progress(block.thinking, "thinking", type));
      } else if (blockType === "text" && typeof block?.text === "string" && block.text.trim()) {
        events.push(progress(block.text, "provider", type));
      } else if (blockType === "tool_use" && typeof block?.name === "string") {
        events.push({
          type: "provider.progress",
          message: `tool: ${block.name}`,
          progress: {
            current_phase: "tool",
            last_meaningful_message: `tool: ${block.name}`,
            last_tool_command: describeToolUse(block.name, block.input),
            last_provider_event: type,
          },
        });
      }
    }
    return events;
  }
}

function progress(message: string, phase: string, providerEvent: string): AdapterEvent {
  return {
    type: "provider.progress",
    message,
    progress: {
      current_phase: phase,
      last_meaningful_message: message,
      last_provider_event: providerEvent,
    },
  };
}

function describeToolUse(name: string, input: unknown): string {
  const record = asRecord(input);
  if (record && typeof record.command === "string") {
    return record.command;
  }
  return name;
}

function lastAssistantText(events: Array<Record<string, unknown>>): string {
  for (const event of [...events].reverse()) {
    if (event.type !== "assistant") continue;
    const message = asRecord(event.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const text = content
      .map((block) => asRecord(block))
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block!.text as string)
      .join("");
    if (text.trim()) return text;
  }
  return "";
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
