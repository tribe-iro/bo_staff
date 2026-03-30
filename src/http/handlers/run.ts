import type { ServerResponse } from "node:http";
import type { BoStaff } from "../../gateway.ts";
import type { BomcpEnvelope } from "../../bomcp/types.ts";
import type { LayeredNormalizeResult } from "../../api/normalize.ts";
import { normalizeLayeredRequest } from "../../api/normalize.ts";
import { buildSyncResult } from "../../api/sync-response.ts";
import { streamExecutionNdjson } from "../streaming/execution-stream.ts";
import { nowIso } from "../../utils.ts";

export async function handleRun(
  response: ServerResponse,
  gateway: BoStaff,
  rawBody: unknown,
  requestId: string,
): Promise<void> {
  // Pre-check: detect stream/verbose flags from the raw request before gateway.execute()
  // normalizes it. We need these to decide sync vs streaming response format.
  const preNormalized = await normalizeLayeredRequest(rawBody);

  if (!preNormalized.ok) {
    response.writeHead(400, { "content-type": "application/json", "x-request-id": requestId });
    response.end(JSON.stringify({
      error: {
        code: "validation_failed",
        message: preNormalized.issues.map((i) => i.message).join("; "),
        issues: preNormalized.issues,
      },
    }, null, 2));
    return;
  }

  if (preNormalized.stream) {
    return handleStreamingRun(response, gateway, preNormalized, requestId);
  }
  return handleSyncRun(response, gateway, preNormalized, requestId);
}

async function handleSyncRun(
  response: ServerResponse,
  gateway: BoStaff,
  normalized: LayeredNormalizeResult,
  requestId: string,
): Promise<void> {
  const envelopes: BomcpEnvelope[] = [];
  const streamWriter = async (envelope: BomcpEnvelope) => {
    envelopes.push(envelope);
  };

  const abortController = new AbortController();
  response.on("close", () => abortController.abort("client_disconnected"));

  try {
    await gateway.executeNormalized({
      request: normalized.request,
      lease: normalized.lease,
      streamWriter,
      signal: abortController.signal,
    });
  } catch (err) {
    // If execution threw, add a synthetic error envelope
    envelopes.push({
      message_id: `err_${Date.now()}`,
      kind: "system.error",
      sequence: envelopes.length + 1,
      timestamp: nowIso(),
      sender: { type: "runtime", id: "runtime" },
      payload: { code: "runtime_error", message: err instanceof Error ? err.message : String(err) },
    });
  }

  const result = buildSyncResult(envelopes, { verbose: normalized.verbose });
  const httpStatus = result.error?.code === "runtime_error" && !result.execution_id ? 500 : 200;

  response.writeHead(httpStatus, {
    "content-type": "application/json",
    "x-request-id": requestId,
  });
  response.end(JSON.stringify(result, null, 2));
}

async function handleStreamingRun(
  response: ServerResponse,
  gateway: BoStaff,
  normalized: LayeredNormalizeResult,
  requestId: string,
): Promise<void> {
  await streamExecutionNdjson({
    response,
    requestId,
    errorLogKey: "http.run_stream",
    onExecute: ({ signal, streamWriter }) => gateway.executeNormalized({
      request: normalized.request,
      lease: normalized.lease,
      streamWriter,
      signal,
    })
  });
}
