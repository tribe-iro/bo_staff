import type { ServerResponse } from "node:http";
import type { BomcpEnvelope } from "../../events/types.ts";
import type { StreamWriter } from "../../bomcp/controller-stream.ts";
import { reportInternalError } from "../../internal-reporting.ts";
import { buildRuntimeErrorEnvelope } from "../../runtime/error-envelope.ts";
import { beginNdjson, endNdjson, writeNdjson } from "./ndjson.ts";

export async function streamExecutionNdjson(input: {
  response: ServerResponse;
  requestId: string;
  onExecute: (args: { signal: AbortSignal; streamWriter: StreamWriter }) => Promise<void>;
  errorLogKey: string;
}): Promise<void> {
  beginNdjson(input.response, input.requestId);
  let streamEnded = false;
  const abortController = new AbortController();

  input.response.on("close", () => {
    if (!streamEnded) {
      abortController.abort("controller_disconnected");
    }
  });

  const streamWriter = async (envelope: BomcpEnvelope) => {
    if (!input.response.destroyed && !input.response.writableEnded) {
      await writeNdjson(input.response, envelope);
    }
  };

  try {
    await input.onExecute({
      signal: abortController.signal,
      streamWriter,
    });
  } catch (error) {
    if (!input.response.destroyed && !input.response.writableEnded) {
      await writeNdjson(input.response, buildRuntimeErrorEnvelope({
        code: "runtime_error",
        message: error instanceof Error ? error.message : String(error),
      })).catch((streamError) => {
        reportInternalError(`${input.errorLogKey}.write_failure_event`, streamError, {
          request_id: input.requestId,
        });
      });
    }
  }

  streamEnded = true;
  await endNdjson(input.response).catch((error) => {
    reportInternalError(`${input.errorLogKey}.end`, error, {
      request_id: input.requestId,
    });
  });
}
