import { asRecord } from "../../utils.ts";
import {
  type AdapterEvent,
  type AdapterExecutionContext,
  type AdapterExecutionSummary,
  type ProviderEventParser
} from "../types.ts";
import { extractJsonObject } from "../../json/extract.ts";
import {
  canonicalizeProviderResultText,
  extractStructuredProviderResultText,
} from "../shared.ts";

export class ClaudeEventParser implements ProviderEventParser {
  private stderrBuffer = "";

  onStdoutChunk(_text: string): AdapterEvent[] {
    return [];
  }

  onStderrChunk(text: string): AdapterEvent[] {
    this.stderrBuffer += text;
    const lines = this.stderrBuffer.split("\n");
    this.stderrBuffer = lines.pop() ?? "";
    return lines.flatMap((line) => this.processLine(line.trim()));
  }

  finish(input: {
    context: AdapterExecutionContext;
    stdout: string;
    stderr: string;
  }): AdapterExecutionSummary {
    const wrapper = asRecord(extractJsonObject(input.stdout)) ?? {};
    const rawText = extractStructuredProviderResultText({
      structured_output: wrapper.structured_output,
      raw_result: wrapper.result
    });
    const canonicalOutput = canonicalizeProviderResultText({
      context: input.context,
      raw_text: rawText
    });
    const usage = asRecord(wrapper.usage);
    const usageSummary = {
      duration_ms: typeof wrapper.duration_ms === "number" ? wrapper.duration_ms : undefined,
      input_tokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : undefined,
      output_tokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : undefined
    };
    return {
      continuation: typeof wrapper.session_id === "string"
        ? { backend: "claude", token: wrapper.session_id }
        : input.context.continuation,
      raw_output_text: canonicalOutput,
      usage: Object.values(usageSummary).some((value) => value !== undefined) ? usageSummary : undefined,
      schema_enforcement_applied: input.context.request.output.format === "custom",
      tool_configuration_outcome: {
        builtin_policy_honored: input.context.request.tool_configuration?.builtin_policy?.mode !== "denylist",
        mcp_servers_requested: input.context.request.tool_configuration?.mcp_servers.length ?? 0,
        mcp_servers_active: input.context.request.tool_configuration?.mcp_servers.length ?? 0
      },
      debug: {
        provider_result_text: rawText,
        stdout: input.stdout,
        stderr: input.stderr
      }
    };
  }

  private processLine(line: string): AdapterEvent[] {
    if (!line) {
      return [];
    }
    return [{
      type: "provider.progress",
      message: line,
      progress: {
        current_phase: classifyClaudePhase(line),
        last_meaningful_message: line,
        last_provider_event: "stderr.line"
      }
    }];
  }
}

function classifyClaudePhase(line: string): string {
  if (/tool|running|executing/i.test(line)) {
    return "tool";
  }
  if (/approve|permission|clarification/i.test(line)) {
    return "approval";
  }
  return "provider";
}
