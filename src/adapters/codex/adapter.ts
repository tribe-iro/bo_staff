import path from "node:path";
import type { AdapterEvent, BackendAdapter } from "../types.ts";
import { CodexEventParser } from "./parser.ts";
import { executeCliAdapter, renderCodexPrompt } from "../shared.ts";
import type { McpServerSpec } from "../../types.ts";

export class CodexAdapter implements BackendAdapter {
  readonly backend = "codex" as const;

  async *execute(context: Parameters<BackendAdapter["execute"]>[0]): AsyncIterable<AdapterEvent> {
    const renderedPrompt = await renderCodexPrompt(context);
    const outputPath = path.join(context.workspace.run_dir, "codex-last-message.json");
    const args = await buildCodexExecArgs(context, outputPath);
    yield* executeCliAdapter({
      context,
      command: "codex",
      args,
      rendered_prompt: renderedPrompt,
      initial_provider_session_id: context.continuation?.token,
      parser: new CodexEventParser({
        finalMessagePath: outputPath
      })
    });
  }
}

export async function buildCodexExecArgs(
  context: Parameters<BackendAdapter["execute"]>[0],
  outputPath: string
): Promise<string[]> {
  const args = context.continuation?.token
    ? [
      "-C", context.workspace.runtime_working_directory,
      "exec",
      "resume"
    ]
    : [
      "-C", context.workspace.runtime_working_directory,
      "exec"
    ];

  args.push(
    "-c", 'sandbox_mode="danger-full-access"',
    "-c", 'approval_policy="never"',
    "--skip-git-repo-check",
    "--json",
    "--output-last-message", outputPath,
    "--model", context.execution_profile.model
  );
  if (context.execution_profile.reasoning_effort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(context.execution_profile.reasoning_effort)}`);
  }

  const hasCallerMcpServers = !!context.request.tool_configuration?.mcp_servers.length;
  const hasBomcpServer = !!context.bomcp_server_config;

  if (hasCallerMcpServers || hasBomcpServer) {
    const mcpServers: McpServerSpec[] = [...(context.request.tool_configuration?.mcp_servers ?? [])];
    if (context.bomcp_server_config) {
      mcpServers.push({
        name: "bomcp",
        transport: "stdio" as const,
        command: context.bomcp_server_config.command,
        args: context.bomcp_server_config.args,
        env: context.bomcp_server_config.env,
        require_approval: "never",
      });
    }
    for (const server of [...mcpServers].sort((left, right) => left.name.localeCompare(right.name))) {
      args.push(...buildMcpServerOverrides(server));
    }
  }

  if (context.request.output.format === "custom") {
    args.push("-c", `output_schema=${JSON.stringify(JSON.stringify(context.request.output.schema))}`);
  }

  if (context.continuation?.token) {
    args.push(context.continuation.token);
  }
  return args;
}

function buildMcpServerOverrides(server: McpServerSpec): string[] {
  const args: string[] = [];
  const prefix = `mcp_servers.${server.name}`;
  if (server.transport === "sse") {
    if (server.url) {
      args.push("-c", `${prefix}.url=${JSON.stringify(server.url)}`);
    }
    if (server.headers && Object.keys(server.headers).length > 0) {
      args.push("-c", `${prefix}.headers=${formatTomlInlineTable(server.headers)}`);
    }
    return args;
  }

  if (server.command) {
    args.push("-c", `${prefix}.command=${JSON.stringify(server.command)}`);
  }
  if (server.args && server.args.length > 0) {
    args.push("-c", `${prefix}.args=${JSON.stringify(server.args)}`);
  }
  if (server.env && Object.keys(server.env).length > 0) {
    args.push("-c", `${prefix}.env=${formatTomlInlineTable(server.env)}`);
  }
  if (server.require_approval) {
    args.push("-c", `${prefix}.require_approval=${JSON.stringify(server.require_approval)}`);
  }
  return args;
}

function formatTomlInlineTable(values: Record<string, string>): string {
  const entries = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return `{${entries.join(",")}}`;
}
