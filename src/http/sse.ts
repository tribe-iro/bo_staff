import type { ServerResponse } from "node:http";
import type { Subscription } from "../core/runs.ts";
import type { StreamEvent } from "../model.ts";

const PING_MS = 15_000;
const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } as const;

/**
 * Writes a subscription to an SSE response, honouring backpressure. A client disconnect closes the subscription at
 * once (releasing its slot) but never cancels the run.
 */
export async function pipeSse(res: ServerResponse, subscription: Subscription): Promise<void> {
  openSse(res);
  res.once("close", subscription.close);
  let chain = Promise.resolve(true);
  const write = (data: string): Promise<boolean> => (chain = chain.then((open) => open && writeBackpressured(res, data)));
  const ping = setInterval(() => { void write(": ping\n\n"); }, PING_MS).unref();
  try {
    for await (const event of subscription.events) if (!await write(frame(event))) break;
  } finally {
    clearInterval(ping);
    res.off("close", subscription.close);
    subscription.close();
    await endSse(res);
  }
}

export function openSse(res: ServerResponse): void {
  res.writeHead(200, SSE_HEADERS);
  res.flushHeaders();
}

export function endSse(res: ServerResponse): Promise<void> {
  return res.writableEnded ? Promise.resolve() : new Promise<void>((resolve) => res.end(resolve));
}

export async function writeBackpressured(res: ServerResponse, data: string): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return false;
  if (res.write(data)) return true;
  return new Promise<boolean>((resolve) => {
    const drain = () => done(true);
    const close = () => done(false);
    const done = (value: boolean) => {
      res.off("drain", drain);
      res.off("close", close);
      res.off("error", close);
      resolve(value);
    };
    res.once("drain", drain);
    res.once("close", close);
    res.once("error", close);
  });
}

export function frame(e: StreamEvent): string {
  const data = `data: ${JSON.stringify(e.data)}\n\n`;
  return "id" in e ? `id: ${e.id}\nevent: ${e.event}\n${data}` : `event: ${e.event}\n${data}`;
}
