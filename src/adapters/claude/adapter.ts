import { writeFile } from "node:fs/promises";
import path from "node:path";
import { requireCliAgentDescriptor } from "../descriptors.ts";
import type { AdapterEvent, CliAgentAdapter } from "../types.ts";
import type { ReasoningTier } from "../../types.ts";
import { ClaudeEventParser } from "./parser.ts";
import { executeCliAdapter, renderClaudePrompt } from "../shared.ts";

const CLAUDE_DESCRIPTOR = requireCliAgentDescriptor("claude");

// Total map from bo_staff's intent tiers to Claude's native `--effort` vocabulary
// (low | medium | high | xhigh | max). Claude has no "none" — omit the flag and let the
// CLI default stand. `xhigh`/`max` are vendor extremes deliberately outside the unified
// surface. Exhaustive by construction: a missing tier is a compile error.
const CLAUDE_EFFORT_BY_TIER: Record<ReasoningTier, string | undefined> = {
  none: undefined,
  light: "low",
  standard: "medium",
  deep: "high",
};

export class ClaudeAdapter implements CliAgentAdapter {
  readonly backend = "claude" as const;
  readonly capabilities = CLAUDE_DESCRIPTOR.capabilities;

  async *execute(context: Parameters<CliAgentAdapter["execute"]>[0]): AsyncIterable<AdapterEvent> {
    const renderedPrompt = await renderClaudePrompt(context);
    const args = await buildClaudeExecArgs(context);

    yield* executeCliAdapter({
      context,
      command: "claude",
      args,
      rendered_prompt: renderedPrompt,
      initial_provider_session_id: context.continuation?.token,
      parser: new ClaudeEventParser()
    });
  }
}

export async function buildClaudeExecArgs(
  context: Parameters<CliAgentAdapter["execute"]>[0],
): Promise<string[]> {
  const args = [
      "-p",
      // stream-json gives a structured live event stream (tool use, thinking, turns),
      // symmetric with Codex's --json. Requires --verbose in print mode.
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--model", context.execution_profile.model
    ];

    if (context.request.runtime.max_turns !== undefined) {
      args.push("--max-turns", String(context.request.runtime.max_turns));
    }
    // Deterministic provider session id when the caller supplied a UUID execution_id (and
    // we're not resuming an existing session). bo_staff still enforces its own lifecycle.
    if (!context.continuation?.token && isUuid(context.execution_id)) {
      args.push("--session-id", context.execution_id);
    }

    const reasoningTier = context.execution_profile.reasoning_effort;
    if (reasoningTier) {
      const effort = CLAUDE_EFFORT_BY_TIER[reasoningTier];
      if (effort) {
        args.push("--effort", effort);
      }
    }
    if (context.continuation?.token) {
      args.push("--resume", context.continuation.token);
    }

    const builtinPolicy = context.request.tool_configuration?.builtin_policy;
    if (builtinPolicy?.mode === "allowlist" && builtinPolicy.tools && builtinPolicy.tools.length > 0) {
      args.push("--allowedTools", builtinPolicy.tools.join(","));
    }
    if (builtinPolicy?.mode === "denylist" && builtinPolicy.tools && builtinPolicy.tools.length > 0) {
      args.push("--disallowedTools", builtinPolicy.tools.join(","));
    }

    const hasCallerMcpServers = !!context.request.tool_configuration?.mcp_servers.length;
    const hasBomcpServer = !!context.bomcp_server_config;

    if (hasCallerMcpServers || hasBomcpServer) {
      const mcpServers: Record<string, { command?: string; args?: string[]; url?: string; env?: Record<string, string> }> = {};
      for (const server of context.request.tool_configuration?.mcp_servers ?? []) {
        mcpServers[server.name] = {
          ...(server.command ? { command: server.command } : {}),
          ...(server.args?.length ? { args: server.args } : {}),
          ...(server.url ? { url: server.url } : {}),
          ...(server.env ? { env: server.env } : {}),
        };
      }
      if (context.bomcp_server_config) {
        mcpServers["bomcp"] = {
          command: context.bomcp_server_config.command,
          args: context.bomcp_server_config.args,
          env: context.bomcp_server_config.env,
        };
      }
      const configPath = path.join(context.workspace.run_dir, ".mcp.json");
      await writeFile(configPath, JSON.stringify({ mcpServers }, null, 2), "utf8");
      args.push("--mcp-config", configPath);
      // Hermetic by default: restrict MCP to bo_staff's injected set, ignoring the host
      // operator's ambient ~/.claude.json servers. bo_staff owns the tool surface.
      if (!context.request.inherit_host_config) {
        args.push("--strict-mcp-config");
      }
    }

    if (context.request.output.format === "custom") {
      args.push("--json-schema", JSON.stringify(context.request.output.schema));
    }
  return args;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string | undefined): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
