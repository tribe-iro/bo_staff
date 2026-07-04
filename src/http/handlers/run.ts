import type { ServerResponse } from "node:http";
import type { BoStaff } from "../../gateway.ts";
import type { BomcpEnvelope } from "../../events/types.ts";
import type { LayeredNormalizeResult } from "../../api/normalize.ts";
import { buildSyncResult } from "../../api/sync-response.ts";
import { buildRuntimeErrorEnvelope } from "../../runtime/error-envelope.ts";
import { streamExecutionNdjson } from "../streaming/execution-stream.ts";
import { formatValidationIssueSummary } from "../../validation/summary.ts";

export async function handleRun(
  response: ServerResponse,
  gateway: BoStaff,
  rawBody: unknown,
  requestId: string,
): Promise<void> {
  const preNormalized = await gateway.prepareExecution(rawBody);

  if (!preNormalized.ok) {
    response.writeHead(400, { "content-type": "application/json", "x-request-id": requestId });
    response.end(JSON.stringify({
      error: {
        code: "validation_failed",
        message: formatValidationIssueSummary(preNormalized.issues),
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
    envelopes.push(buildRuntimeErrorEnvelope(
      { code: "runtime_error", message: err instanceof Error ? err.message : String(err) },
      { sequence: envelopes.length + 1 },
    ));
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
