import { readFile } from "node:fs/promises";
import { asRecord, isPlainObject } from "../../utils.ts";
import { normalizeProviderResultText } from "../shared.ts";
import type { AdapterExecutionContext, AdapterExecutionSummary } from "../types.ts";
import type { UsageSummary } from "../../types.ts";

export async function translateCodexTerminal(input: {
  context: AdapterExecutionContext;
  stdout: string;
  stderr: string;
  finalMessagePath: string;
}): Promise<AdapterExecutionSummary> {
  const streamEvents = parseJsonLines(input.stdout);
  let rawOutput = "";
  try {
    rawOutput = await readFile(input.finalMessagePath, "utf8");
  } catch {
    rawOutput = "";
  }
  if (!rawOutput.trim()) {
    const itemCompleted = [...streamEvents].reverse().find((entry) => entry.type === "item.completed");
    const item = asRecord(itemCompleted?.item);
    rawOutput = typeof item?.text === "string" ? item.text : "";
  }

  const usageEvent = [...streamEvents].reverse().find((entry) => entry.type === "turn.completed");
  const usageRecord = asRecord(usageEvent?.usage);
  const usage: UsageSummary | undefined = usageRecord
    ? {
      duration_ms: typeof usageRecord.duration_ms === "number" ? usageRecord.duration_ms : undefined,
      input_tokens: typeof usageRecord.input_tokens === "number" ? usageRecord.input_tokens : undefined,
      output_tokens: typeof usageRecord.output_tokens === "number" ? usageRecord.output_tokens : undefined
    }
    : undefined;

  const threadStarted = streamEvents.find((entry) => entry.type === "thread.started");

  return {
    provider_session_id: typeof threadStarted?.thread_id === "string"
      ? threadStarted.thread_id
      : input.context.session.provider_session_id,
    raw_output_text: normalizeProviderResultText(rawOutput),
    usage,
    debug: {
      provider_result_text: rawOutput,
      stdout: input.stdout,
      stderr: input.stderr
    }
  };
}

function parseJsonLines(raw: string): Array<Record<string, unknown>> {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return isPlainObject(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
}
