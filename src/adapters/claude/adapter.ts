import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterEvent, BackendAdapter } from "../types.ts";
import { ClaudeEventParser } from "./parser.ts";
import { executeCliAdapter, renderClaudePrompt } from "../shared.ts";

export class ClaudeAdapter implements BackendAdapter {
  readonly backend = "claude" as const;

  async *execute(context: Parameters<BackendAdapter["execute"]>[0]): AsyncIterable<AdapterEvent> {
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
  context: Parameters<BackendAdapter["execute"]>[0],
): Promise<string[]> {
  const args = [
      "-p",
      "--output-format", "json",
      "--permission-mode",
      "bypassPermissions",
      "--model", context.execution_profile.model
    ];

    if (context.execution_profile.reasoning_effort) {
      args.push("--effort", context.execution_profile.reasoning_effort);
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
    }

    if (context.request.output.format === "custom") {
      args.push("--json-schema", JSON.stringify(context.request.output.schema));
    }
  return args;
}
