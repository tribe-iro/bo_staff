import { isPlainObject } from "../utils.ts";

// Shared newline-delimited-JSON framing for provider event streams. Both the Claude
// (`--output-format stream-json`) and Codex (`--json`) adapters emit one JSON object per
// line; this is the framing they share. The *vocabularies* differ (Claude content_block /
// tool_use vs Codex thread / turn / item), so each adapter keeps its own mapper — this is
// only the line buffer + a defensive object parser, not a unified parser.

export class NdjsonLineBuffer {
  private buffer = "";

  /** Append a chunk and return any newly-completed, non-empty lines (trimmed). */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split("\n");
    this.buffer = parts.pop() ?? "";
    return parts.map((line) => line.trim()).filter((line) => line.length > 0);
  }
}

/** Parse one line as a JSON object. Returns undefined on malformed input or non-objects — never throws. */
export function parseJsonObject(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Split a complete buffer into parsed JSON objects, skipping malformed lines. */
export function parseJsonObjectLines(raw: string): Array<Record<string, unknown>> {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const parsed = parseJsonObject(line);
      return parsed ? [parsed] : [];
    });
}
