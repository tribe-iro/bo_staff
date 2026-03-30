#!/usr/bin/env node

// bomcp-server: Per-execution MCP stdio server.
// Reads env vars: BO_MCP_EXECUTION_ID, BO_MCP_IPC_ADDRESS
// Exposes bomcp.* tools over MCP stdio, bridges each tool call to IPC.

import { createIpcClient, type IpcClient } from "./ipc-channel.ts";
import type { IpcToolCallRequest, IpcToolCallResponse } from "./types.ts";
import { BOMCP_HANDOFF_KINDS, BOMCP_TOOL_NAMES } from "./types.ts";
import {
  jsonRpcError,
  jsonRpcSuccess,
  parseJsonRpcRequestLine,
  parseToolCallParams,
} from "./jsonrpc.ts";

const TOOL_SCHEMAS: Record<string, { description: string; parameters: Record<string, unknown> }> = {
  "bomcp.control.handoff": {
    description: "Emit a structured execution-scoped handoff signal from the agent to the caller.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...BOMCP_HANDOFF_KINDS] },
        reason_code: { type: "string" },
        description: { type: "string" },
        next: {
          type: "object",
          properties: {
            node_id: { type: "string" },
            prompt_id: { type: "string" },
          },
        },
        input_request: {
          type: "object",
          properties: {
            kind: { type: "string" },
            prompt: { type: "string" },
          },
        },
        missing_refs: { type: "array", items: { type: "string" } },
        payload: { type: "object" },
      },
      required: ["kind"],
    },
  },
  "bomcp.artifact.register": {
    description: "Register a durable artifact that the agent has produced.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string" },
        path: { type: "string" },
        metadata: { type: "object" },
      },
      required: ["kind", "path"],
    },
  },
  "bomcp.artifact.require": {
    description: "Check whether a required in-scope artifact exists.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string" },
        path: { type: "string" },
      },
      required: ["kind", "path"],
    },
  },
  "bomcp.progress.update": {
    description: "Emit a structured progress update for the caller's live stream.",
    parameters: {
      type: "object",
      properties: {
        phase: { type: "string" },
        percent: { type: "number" },
        detail: { type: "string" },
      },
    },
  },
};

let requestCounter = 0;
const DEFAULT_IPC_CALL_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  const executionId = process.env.BO_MCP_EXECUTION_ID;
  const ipcAddress = process.env.BO_MCP_IPC_ADDRESS;

  if (!executionId || !ipcAddress) {
    process.stderr.write("bomcp-server: missing BO_MCP_EXECUTION_ID or BO_MCP_IPC_ADDRESS\n");
    process.exit(1);
  }

  const client = createIpcClient(ipcAddress);
  await client.connect();

  const stdin = process.stdin;
  const stdout = process.stdout;
  stdin.setEncoding("utf8");

  let buffer = "";
  stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      void handleJsonRpc(line, stdout, client, executionId);
    }
  });

  stdin.on("end", () => {
    client.disconnect();
    process.exit(0);
  });
}

async function handleJsonRpc(
  line: string,
  stdout: NodeJS.WriteStream,
  client: IpcClient,
  executionId: string,
): Promise<void> {
  const parsed = parseJsonRpcRequestLine(line);
  if (!parsed.ok) {
    process.stderr.write(`bomcp-server: ${parsed.logMessage}\n`);
    stdout.write(JSON.stringify(parsed.response) + "\n");
    return;
  }

  const { id, method, params } = parsed.request;
  const rpcId = id ?? null;

  if (method === "initialize") {
    stdout.write(JSON.stringify(jsonRpcSuccess(rpcId, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "bomcp", version: "0.1.0" },
      })) + "\n");
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "tools/list") {
    const tools = BOMCP_TOOL_NAMES.map((name) => ({
      name,
      description: TOOL_SCHEMAS[name]?.description ?? "",
      inputSchema: TOOL_SCHEMAS[name]?.parameters ?? { type: "object" },
    }));
    stdout.write(JSON.stringify(jsonRpcSuccess(rpcId, { tools })) + "\n");
    return;
  }

  if (method === "tools/call") {
    const toolCall = parseToolCallParams(params);
    if (!toolCall.ok) {
      stdout.write(JSON.stringify({ ...toolCall.response, id: rpcId }) + "\n");
      return;
    }
    const { name: toolName, arguments_: toolArgs } = toolCall;
    const requestId = `req_${executionId}_${(++requestCounter).toString(36)}`;

    const ipcReq: IpcToolCallRequest = {
      type: "tool_call",
      tool_name: toolName,
      params: toolArgs ?? {},
      request_id: requestId,
    };

    try {
      const ipcResp: IpcToolCallResponse = await client.callTool(ipcReq, {
        timeoutMs: DEFAULT_IPC_CALL_TIMEOUT_MS,
      });
      if (ipcResp.error) {
        stdout.write(JSON.stringify(jsonRpcSuccess(rpcId, {
            content: [{ type: "text", text: JSON.stringify(ipcResp.error) }],
            isError: true,
          })) + "\n");
      } else {
        stdout.write(JSON.stringify(jsonRpcSuccess(rpcId, {
            content: [{ type: "text", text: JSON.stringify(ipcResp.result) }],
          })) + "\n");
      }
    } catch (err) {
      stdout.write(JSON.stringify(jsonRpcSuccess(rpcId, {
          content: [{ type: "text", text: `IPC error: ${err}` }],
          isError: true,
        })) + "\n");
    }
    return;
  }

  stdout.write(JSON.stringify(jsonRpcError(rpcId, -32601, `Method not found: ${method}`)) + "\n");
}

main().catch((err) => {
  process.stderr.write(`bomcp-server fatal: ${err}\n`);
  process.exit(1);
});
