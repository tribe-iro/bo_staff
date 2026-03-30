import type { IncomingMessage, ServerResponse } from "node:http";
import { TextDecoder } from "node:util";
import type { BoStaff } from "../../gateway.ts";
import type { ActiveExecutionResponse, CancelExecutionResponse } from "../../types.ts";
import { beginNdjson, endNdjson, writeNdjson } from "../streaming/ndjson.ts";
import { streamExecutionNdjson } from "../streaming/execution-stream.ts";
import { HttpRequestError, writeNotFound } from "../errors.ts";
import { nowIso } from "../../utils.ts";

export async function handleExecuteStream(
  response: ServerResponse,
  gateway: BoStaff,
  rawBody: unknown,
  requestId: string,
): Promise<void> {
  await streamExecutionNdjson({
    response,
    requestId,
    errorLogKey: "http.execute_stream",
    onExecute: ({ signal, streamWriter }) => gateway.execute({
      rawRequest: rawBody,
      streamWriter,
      signal,
    })
  });
}

export async function handleGetExecution(
  response: ServerResponse,
  gateway: BoStaff,
  executionId: string,
  requestId: string,
): Promise<void> {
  const state = gateway.getActiveExecution(executionId);
  if (!state) {
    writeNotFound(response, requestId, `No active execution: ${executionId}`);
    return;
  }
  response.writeHead(200, {
    "content-type": "application/json",
    "x-request-id": requestId,
  });
  const body: ActiveExecutionResponse = {
    execution_id: state.execution_id,
    status: state.status,
    backend: state.backend,
    started_at: state.started_at,
    artifacts: [...state.artifacts.values()],
  };
  response.end(JSON.stringify(body, null, 2));
}

export async function handleCancelExecution(
  response: ServerResponse,
  gateway: BoStaff,
  executionId: string,
  requestId: string,
): Promise<void> {
  const result = await gateway.cancelExecution(executionId);
  if (result === "not_found") {
    writeNotFound(response, requestId, `No active execution: ${executionId}`);
    return;
  }
  response.writeHead(202, {
    "content-type": "application/json",
    "x-request-id": requestId,
  });
  const body: CancelExecutionResponse = { cancelled: true, execution_id: executionId };
  response.end(JSON.stringify(body, null, 2));
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
  if (Array.isArray(value)) return value.some(isJsonContentType);
  if (typeof value !== "string") return false;
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return normalized === "application/json" || normalized.endsWith("+json");
}

export async function writeRejectedStream(
  response: ServerResponse,
  requestId: string,
  input: { code: string; message: string },
): Promise<void> {
  beginNdjson(response, requestId);
  await writeNdjson(response, {
    message_id: `rej_${Date.now()}`,
    kind: "system.error",
    sequence: 1,
    timestamp: nowIso(),
    sender: { type: "runtime", id: "runtime" },
    payload: {
      code: input.code,
      message: input.message,
    },
  });
  await endNdjson(response);
}
