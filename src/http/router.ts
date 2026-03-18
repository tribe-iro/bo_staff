import type { IncomingMessage, ServerResponse } from "node:http";
import { generateHandle } from "../utils.ts";
import { isSafeExecutionId, isSafeSessionHandle } from "../core/index.ts";
import { handleHealth } from "./handlers/health.ts";
import { handleDeleteSession, handleGetSession, handleListSessions } from "./handlers/sessions.ts";
import {
  handleCancelExecution,
  handleExecute,
  handleExecuteStream,
  handleGetExecution,
  handleGetExecutionEvents,
  readJsonBody,
  writeRejectedStream
} from "./handlers/executions.ts";
import { HttpRequestError, writeJsonError } from "./errors.ts";
import type { BoStaff } from "../gateway.ts";
import { RequestResolutionError } from "../errors.ts";

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
    if (input.request.method === "GET" && segments.length === 1 && segments[0] === "health") {
      await handleHealth(input.response, input.gateway, requestId);
      return true;
    }
    if (input.request.method === "GET" && segments.length === 1 && segments[0] === "sessions") {
      const rawLimit = url.searchParams.get("limit");
      await handleListSessions(input.response, input.gateway, requestId, {
        limit: rawLimit === null ? undefined : Number(rawLimit),
        cursor: url.searchParams.get("cursor") ?? undefined
      });
      return true;
    }
    if (input.request.method === "GET" && segments.length === 2 && segments[0] === "sessions") {
      const handle = decodeURIComponent(segments[1]);
      assertValidSessionHandle(handle);
      await handleGetSession(
        input.response,
        input.gateway,
        handle,
        requestId
      );
      return true;
    }
    if (input.request.method === "DELETE" && segments.length === 2 && segments[0] === "sessions") {
      const handle = decodeURIComponent(segments[1]);
      assertValidSessionHandle(handle);
      await handleDeleteSession(
        input.response,
        input.gateway,
        handle,
        requestId
      );
      return true;
    }
    if (input.request.method === "GET" && segments.length === 3 && segments[0] === "executions" && segments[2] === "events") {
      const executionId = decodeURIComponent(segments[1]);
      assertValidExecutionId(executionId);
      await handleGetExecutionEvents(input.response, input.gateway, executionId, requestId);
      return true;
    }
    if (input.request.method === "POST" && segments.length === 3 && segments[0] === "executions" && segments[2] === "cancel") {
      const executionId = decodeURIComponent(segments[1]);
      assertValidExecutionId(executionId);
      await handleCancelExecution(
        input.response,
        input.gateway,
        executionId,
        requestId
      );
      return true;
    }
    if (input.request.method === "GET" && segments.length === 2 && segments[0] === "executions") {
      const executionId = decodeURIComponent(segments[1]);
      assertValidExecutionId(executionId);
      await handleGetExecution(
        input.response,
        input.gateway,
        executionId,
        requestId
      );
      return true;
    }
    if (input.request.method === "POST" && segments.length === 1 && segments[0] === "executions") {
      const body = await readJsonBody(input.request, input.maxBodyBytes);
      await handleExecute(input.response, input.gateway, body, requestId);
      return true;
    }
    if (input.request.method === "POST" && segments.length === 2 && segments[0] === "executions" && segments[1] === "stream") {
      let body: unknown;
      try {
        body = await readJsonBody(input.request, input.maxBodyBytes);
      } catch (error) {
        if (error instanceof HttpRequestError) {
          await writeRejectedStream(input.response, requestId, {
            code: error.code,
            message: error.message,
            httpStatus: error.status
          });
          return true;
        }
        throw error;
      }
      await handleExecuteStream(input.response, input.gateway, body, requestId);
      return true;
    }
  } catch (error) {
    writeJsonError(input.response, {
      requestId,
      status: error instanceof HttpRequestError
        ? error.status
        : error instanceof RequestResolutionError
          ? error.httpStatus
          : 500,
      code: error instanceof HttpRequestError
        ? error.code
        : error instanceof RequestResolutionError
          ? error.code
          : "runtime_error",
      message: error instanceof Error ? error.message : String(error)
    });
    return true;
  }

  return false;
}

function assertValidSessionHandle(handle: string): void {
  if (!isSafeSessionHandle(handle)) {
    throw new HttpRequestError(400, "invalid_session_handle", `Invalid session handle: ${handle}`);
  }
}

function assertValidExecutionId(executionId: string): void {
  if (!isSafeExecutionId(executionId)) {
    throw new HttpRequestError(400, "invalid_execution_id", `Invalid execution id: ${executionId}`);
  }
}
