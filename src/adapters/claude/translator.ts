import { asRecord } from "../../utils.ts";
import { extractJsonObject } from "../../json/extract.ts";
import { normalizeProviderResultText } from "../shared.ts";
import type { AdapterExecutionContext, AdapterExecutionSummary } from "../types.ts";

export function translateClaudeTerminal(input: {
  context: AdapterExecutionContext;
  stdout: string;
  stderr: string;
}): AdapterExecutionSummary {
  const wrapper = asRecord(extractJsonObject(input.stdout)) ?? {};
  const rawResult = wrapper.result;
  const rawText = typeof rawResult === "string"
    ? rawResult
    : rawResult !== undefined
      ? JSON.stringify(rawResult)
      : "";
  const canonicalOutput = normalizeProviderResultText(rawText);
  const usage = asRecord(wrapper.usage);
  const usageSummary = {
    duration_ms: typeof wrapper.duration_ms === "number" ? wrapper.duration_ms : undefined,
    input_tokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : undefined,
    output_tokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : undefined
  };
  return {
    provider_session_id: typeof wrapper.session_id === "string"
      ? wrapper.session_id
      : input.context.session.provider_session_id,
    raw_output_text: canonicalOutput,
    usage: Object.values(usageSummary).some((value) => value !== undefined) ? usageSummary : undefined,
    debug: {
      provider_result_text: rawText,
      stdout: input.stdout,
      stderr: input.stderr
    }
  };
}
