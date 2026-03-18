import type { ServerResponse } from "node:http";

export function beginNdjson(response: ServerResponse, requestId: string): void {
  response.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-store",
    "x-request-id": requestId
  });
}

export async function writeNdjson(response: ServerResponse, value: unknown): Promise<void> {
  if (response.writableEnded || response.destroyed) {
    throw new Error("NDJSON stream is no longer writable");
  }
  const accepted = response.write(`${JSON.stringify(value)}\n`);
  if (accepted) {
    return;
  }
  await waitForDrain(response);
}

export async function endNdjson(response: ServerResponse): Promise<void> {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  await new Promise<void>((resolve) => {
    response.end(() => {
      resolve();
    });
  });
}

async function waitForDrain(response: ServerResponse): Promise<void> {
  if (response.destroyed) {
    throw new Error("NDJSON stream was destroyed before drain");
  }
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("NDJSON stream closed before drain"));
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
    };
    response.on("drain", onDrain);
    response.on("close", onClose);
    response.on("error", onError);
  });
}
