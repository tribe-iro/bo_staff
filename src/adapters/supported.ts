import type { CliAgentAdapter } from "./types.ts";
import { ClaudeAdapter } from "./claude/adapter.ts";
import { CodexAdapter } from "./codex/adapter.ts";

export function createSupportedCliAgentAdapters(): CliAgentAdapter[] {
  return [new CodexAdapter(), new ClaudeAdapter()];
}
