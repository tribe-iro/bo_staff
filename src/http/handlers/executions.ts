import type { IncomingMessage, ServerResponse } from "node:http";
import { TextDecoder } from "node:util";
import type { BoStaff } from "../../gateway.ts";
import { beginNdjson, endNdjson, writeNdjson } from "../streaming/ndjson.ts";
import { HttpRequestError, writeNotFound } from "../errors.ts";
import { nowIso } from "../../utils.ts";
import { reportInternalError } from "../../internal-reporting.ts";

export async function handleExecute(response: ServerResponse, gateway: BoStaff, rawBody: unknown, requestId: string): Promise<void> {
  const result = await gateway.execute(rawBody, requestId);
  response.writeHead(result.httpStatus, {
    "content-type": "application/json",
    "x-request-id": requestId
  });
  response.end(JSON.stringify(result.body, null, 2));
}

export async function handleExecuteStream(response: ServerResponse, gateway: BoStaff, rawBody: unknown, requestId: string): Promise<void> {
  // HTTP 200 here means the NDJSON transport was established. Clients must treat the terminal
  // stream event, not the HTTP status code, as the authoritative execution outcome.
  beginNdjson(response, requestId);
  let latestExecutionId: string | null = null;
  let streamEnded = false;
  response.on("close", () => {
    if (!streamEnded && latestExecutionId) {
      void gateway.cancelExecution(latestExecutionId);
    }
  });
  try {
    await gateway.execute(rawBody, requestId, {
      async onExecutionCreated(executionId) {
        latestExecutionId = executionId;
      },
      async onEvent(event) {
        latestExecutionId = event.execution_id;
        await writeNdjson(response, event);
      }
    });
  } catch (error) {
    if (!response.destroyed && !response.writableEnded) {
      await writeNdjson(response, {
        event: "execution.failed",
        request_id: requestId,
        execution_id: latestExecutionId,
        emitted_at: nowIso(),
        data: {
          code: "runtime_error",
          message: error instanceof Error ? error.message : String(error)
        }
      }).catch((streamError) => {
        reportInternalError("http.execute_stream.write_failure_event", streamError, {
          request_id: requestId,
          execution_id: latestExecutionId
        });
      });
    }
  }
  streamEnded = true;
  await endNdjson(response).catch((error) => {
    reportInternalError("http.execute_stream.end", error, {
      request_id: requestId,
      execution_id: latestExecutionId
    });
  });
}

export async function handleGetExecution(
  response: ServerResponse,
  gateway: BoStaff,
  executionId: string,
  requestId: string
): Promise<void> {
  const execution = await gateway.getExecution(executionId);
  if (!execution) {
    writeNotFound(response, requestId, `Unknown execution id: ${executionId}`);
    return;
  }
  response.writeHead(200, {
    "content-type": "application/json",
    "x-request-id": requestId
  });
  response.end(JSON.stringify({ execution }, null, 2));
}

export async function handleGetExecutionEvents(
  response: ServerResponse,
  gateway: BoStaff,
  executionId: string,
  requestId: string
): Promise<void> {
  const execution = await gateway.getExecution(executionId);
  if (!execution) {
    writeNotFound(response, requestId, `Unknown execution id: ${executionId}`);
    return;
  }
  const events = await gateway.getExecutionEvents(executionId);
  response.writeHead(200, {
    "content-type": "application/json",
    "x-request-id": requestId
  });
  response.end(JSON.stringify({ events }, null, 2));
}

export async function handleCancelExecution(
  response: ServerResponse,
  gateway: BoStaff,
  executionId: string,
  requestId: string
): Promise<void> {
  const result = await gateway.cancelExecution(executionId);
  if (result === "not_found") {
    writeNotFound(response, requestId, `Unknown execution id: ${executionId}`);
    return;
  }
  if (result === "already_terminal" || result === "not_cancellable") {
    response.writeHead(409, {
      "content-type": "application/json",
      "x-request-id": requestId
    });
    response.end(JSON.stringify({
      error: {
        code: result,
        message: result === "already_terminal"
          ? `Execution is already terminal: ${executionId}`
          : `Execution is not currently cancellable: ${executionId}`
      }
    }, null, 2));
    return;
  }
  response.writeHead(202, {
    "content-type": "application/json",
    "x-request-id": requestId
  });
  response.end(JSON.stringify({ cancelled: true, execution_id: executionId }, null, 2));
}

export async function readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const contentType = req.headers["content-type"];
  if (!isJsonContentType(contentType)) {
    throw new HttpRequestError(415, "unsupported_media_type", "Request content-type must be application/json");
  }
  const decoder = new TextDecoder("utf-8");
  let rawText = "";
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    totalBytes += buffer.length;
    if (totalBytes > maxBodyBytes) {
      throw new HttpRequestError(413, "body_too_large", `Request body exceeds ${maxBodyBytes} bytes`);
    }
    rawText += decoder.decode(buffer, { stream: true });
  }
  rawText += decoder.decode();
  if (!rawText.trim()) {
    throw new HttpRequestError(400, "empty_body", "Request body must not be empty");
  }
  try {
    return JSON.parse(rawText);
  } catch {
    throw new HttpRequestError(400, "invalid_json", "Request body must be valid JSON");
  }
}

function isJsonContentType(value: string | string[] | undefined): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => isJsonContentType(entry));
  }
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return normalized === "application/json" || normalized.endsWith("+json");
}

export async function writeRejectedStream(response: ServerResponse, requestId: string, input: {
  code: string;
  message: string;
  httpStatus: number;
}): Promise<void> {
  beginNdjson(response, requestId);
  await writeNdjson(response, {
    event: "execution.rejected",
    request_id: requestId,
    execution_id: null,
    emitted_at: nowIso(),
    data: {
      code: input.code,
      message: input.message,
      http_status: input.httpStatus
    }
  });
  await endNdjson(response);
}
