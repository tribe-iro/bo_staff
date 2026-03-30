import type { IncomingMessage, ServerResponse } from "node:http";
import { generateHandle } from "../utils.ts";
import { isSafeExecutionId } from "../core/index.ts";
import { handleHealth } from "./handlers/health.ts";
import {
  handleCancelExecution,
  handleExecuteStream,
  handleGetExecution,
  readJsonBody,
  writeRejectedStream,
} from "./handlers/executions.ts";
import {
  handleRun
} from "./handlers/run.ts";
import { HttpRequestError, writeJsonError } from "./errors.ts";
import type { BoStaff } from "../gateway.ts";

export async function routeHttp(input: {
  request: IncomingMessage;
  response: ServerResponse;
  gateway: BoStaff;
  maxBodyBytes: number;
}): Promise<boolean> {
  const requestId = generateHandle("req");
  const url = new URL(input.request.url ?? "/", "http://127.0.0.1");
  const segments = url.pathname.split("/").filter(Boolean);

  try {
    // GET /health
    if (input.request.method === "GET" && segments.length === 1 && segments[0] === "health") {
      await handleHealth(input.response, input.gateway, requestId);
      return true;
    }

    // POST /run
    if (input.request.method === "POST" && segments.length === 1 && segments[0] === "run") {
      const body = await readJsonBody(input.request, input.maxBodyBytes);
      await handleRun(input.response, input.gateway, body, requestId);
      return true;
    }

    // POST /executions/stream (Layer 2 direct access)
    if (input.request.method === "POST" && segments.length === 2 && segments[0] === "executions" && segments[1] === "stream") {
      let body: unknown;
      try {
        body = await readJsonBody(input.request, input.maxBodyBytes);
      } catch (error) {
        if (error instanceof HttpRequestError) {
          await writeRejectedStream(input.response, requestId, {
            code: error.code,
            message: error.message,
          });
          return true;
        }
        throw error;
      }
      await handleExecuteStream(input.response, input.gateway, body, requestId);
      return true;
    }

    // GET /executions/{id} — live status only
    if (input.request.method === "GET" && segments.length === 2 && segments[0] === "executions") {
      const executionId = decodeURIComponent(segments[1]);
      assertValidExecutionId(executionId);
      await handleGetExecution(input.response, input.gateway, executionId, requestId);
      return true;
    }

    // POST /executions/{id}/cancel
    if (input.request.method === "POST" && segments.length === 3 && segments[0] === "executions" && segments[2] === "cancel") {
      const executionId = decodeURIComponent(segments[1]);
      assertValidExecutionId(executionId);
      await handleCancelExecution(input.response, input.gateway, executionId, requestId);
      return true;
    }

  } catch (error) {
    writeJsonError(input.response, {
      requestId,
      status: error instanceof HttpRequestError ? error.status : 500,
      code: error instanceof HttpRequestError ? error.code : "runtime_error",
      message: error instanceof Error ? error.message : String(error),
    });
    return true;
  }

  return false;
}

function assertValidExecutionId(executionId: string): void {
  if (!isSafeExecutionId(executionId)) {
    throw new HttpRequestError(400, "invalid_execution_id", `Invalid execution id: ${executionId}`);
  }
}
