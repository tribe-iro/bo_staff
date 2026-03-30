import { readFile } from "node:fs/promises";
import { asRecord, isPlainObject } from "../../utils.ts";
import {
  canonicalizeProviderResultText
} from "../shared.ts";
import {
  type AdapterEvent,
  type AdapterExecutionContext,
  type AdapterExecutionSummary,
  type ProviderEventParser
} from "../types.ts";
import type { UsageSummary } from "../../types.ts";

export class CodexEventParser implements ProviderEventParser {
  private buffer = "";
  private readonly finalMessagePath: string;
  private turnCount = 0;

  constructor(input: { finalMessagePath: string }) {
    this.finalMessagePath = input.finalMessagePath;
  }

  onStdoutChunk(text: string): AdapterEvent[] {
    return this.processText(text);
  }

  onStderrChunk(_text: string): AdapterEvent[] {
    return [];
  }

  async finish(input: {
    context: AdapterExecutionContext;
    stdout: string;
    stderr: string;
  }): Promise<AdapterExecutionSummary> {
    const streamEvents = parseJsonLines(input.stdout);
    let rawOutput = "";
    try {
      rawOutput = await readFile(this.finalMessagePath, "utf8");
    } catch {
      rawOutput = "";
    }
    if (!rawOutput.trim()) {
      const itemCompleted = [...streamEvents].reverse().find((entry) => entry.type === "item.completed");
      const item = asRecord(itemCompleted?.item);
      rawOutput = typeof item?.text === "string" ? item.text : "";
    }

    const canonicalOutput = canonicalizeProviderResultText({
      context: input.context,
      raw_text: rawOutput
    });
    const usageEvent = [...streamEvents].reverse().find((entry) => entry.type === "turn.completed");
    const usageRecord = asRecord(usageEvent?.usage);
    const usage: UsageSummary | undefined = usageRecord
      ? {
        duration_ms: typeof usageRecord.duration_ms === "number" ? usageRecord.duration_ms : undefined,
        input_tokens: typeof usageRecord.input_tokens === "number" ? usageRecord.input_tokens : undefined,
        output_tokens: typeof usageRecord.output_tokens === "number" ? usageRecord.output_tokens : undefined,
        turns: this.turnCount || undefined
      }
      : undefined;

    const threadStarted = streamEvents.find((entry) => entry.type === "thread.started");
    const mcpRequested = input.context.request.tool_configuration?.mcp_servers.length ?? 0;
    const builtinMode = input.context.request.tool_configuration?.builtin_policy?.mode ?? "default";

    return {
      continuation: typeof threadStarted?.thread_id === "string"
        ? { backend: "codex", token: threadStarted.thread_id }
        : input.context.continuation,
      raw_output_text: canonicalOutput,
      usage,
      schema_enforcement_applied: false,
      tool_configuration_outcome: {
        builtin_policy_honored: builtinMode === "default",
        mcp_servers_requested: mcpRequested,
        mcp_servers_active: 0,
        failed_mcp_servers: mcpRequested > 0
          ? (input.context.request.tool_configuration?.mcp_servers.map((server) => server.name) ?? [])
          : undefined
      },
      debug: {
        provider_result_text: rawOutput,
        stdout: input.stdout,
        stderr: input.stderr
      }
    };
  }

  private processText(chunk: string): AdapterEvent[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.flatMap((line) => this.processLine(line.trim()));
  }

  private processLine(line: string): AdapterEvent[] {
    if (!line) {
      return [];
    }
    const record = parseJsonLine(line);
    if (!record) {
      return [];
    }
    const events: AdapterEvent[] = [];
    const type = typeof record.type === "string" ? record.type : "unknown";
    const message = extractMessage(record);
    const progress = buildProgressProjection({
      type,
      message,
      toolCommand: extractToolCommand(record)
    });
    switch (type) {
      case "thread.started":
        events.push({
          type: "provider.progress",
          message: "Codex thread started.",
          progress
        });
        break;
      case "turn.started":
        this.turnCount += 1;
        events.push({
          type: "provider.turn_boundary",
          turn_number: this.turnCount
        });
        events.push({
          type: "provider.progress",
          message: "Codex turn started.",
          progress
        });
        break;
      case "item.started":
      case "item.completed":
      case "turn.completed":
      case "turn.failed":
      case "error":
        if (message || progress.last_tool_command) {
          events.push({
            type: "provider.progress",
            message,
            usage: extractUsage(record),
            progress
          });
        }
        break;
      default:
        if (message) {
          events.push({
            type: "provider.progress",
            message,
            progress
          });
        }
        break;
    }

    return events;
  }
}

function parseJsonLines(raw: string): Array<Record<string, unknown>> {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      const parsed = parseJsonLine(line);
      return parsed ? [parsed] : [];
    });
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractUsage(record: Record<string, unknown>): Partial<UsageSummary> | undefined {
  const usage = asRecord(record.usage);
  if (!usage) {
    return undefined;
  }
  const summary: Partial<UsageSummary> = {
    duration_ms: typeof usage.duration_ms === "number" ? usage.duration_ms : undefined,
    input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
    output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined
  };
  return Object.values(summary).some((value) => value !== undefined) ? summary : undefined;
}

function extractMessage(record: Record<string, unknown>): string | undefined {
  const directMessage = typeof record.message === "string" ? record.message : undefined;
  if (directMessage) {
    return directMessage;
  }
  const item = asRecord(record.item);
  if (typeof item?.message === "string") {
    return item.message;
  }
  if (typeof item?.text === "string") {
    return item.text;
  }
  if (typeof record.text === "string") {
    return record.text;
  }
  return undefined;
}

function extractToolCommand(record: Record<string, unknown>): string | undefined {
  const item = asRecord(record.item);
  const command = asRecord(item?.command);
  if (typeof command?.cmd === "string") {
    return command.cmd;
  }
  if (typeof item?.command === "string") {
    return item.command;
  }
  return undefined;
}

function buildProgressProjection(input: {
  type: string;
  message?: string;
  toolCommand?: string;
}) {
  return {
    current_phase: mapPhase(input.type),
    last_meaningful_message: input.message,
    last_tool_command: input.toolCommand,
    last_provider_event: input.type
  };
}

function mapPhase(type: string): string {
  if (type.startsWith("thread.")) {
    return "session";
  }
  if (type.startsWith("turn.")) {
    return "turn";
  }
  if (type.startsWith("item.")) {
    return "item";
  }
  return "provider";
}
