import type { ServerResponse } from "node:http";
import type { BoStaff } from "../../gateway.ts";
import { writeNotFound } from "../errors.ts";

export async function handleListSessions(
  response: ServerResponse,
  gateway: BoStaff,
  requestId: string,
  input?: { limit?: number; cursor?: string }
): Promise<void> {
  const listing = await gateway.listSessions(input);
  response.writeHead(200, {
    "content-type": "application/json",
    "x-request-id": requestId
  });
  response.end(JSON.stringify(listing, null, 2));
}

export async function handleGetSession(response: ServerResponse, gateway: BoStaff, handle: string, requestId: string): Promise<void> {
  const session = await gateway.getSession(handle);
  if (!session) {
    writeNotFound(response, requestId, `Unknown session handle: ${handle}`);
    return;
  }
  response.writeHead(200, {
    "content-type": "application/json",
    "x-request-id": requestId
  });
  response.end(JSON.stringify({ session }, null, 2));
}

export async function handleDeleteSession(response: ServerResponse, gateway: BoStaff, handle: string, requestId: string): Promise<void> {
  const deleted = await gateway.deleteSession(handle);
  if (!deleted) {
    writeNotFound(response, requestId, `Unknown session handle: ${handle}`);
    return;
  }
  response.writeHead(200, {
    "content-type": "application/json",
    "x-request-id": requestId
  });
  response.end(JSON.stringify({ deleted: true, handle }, null, 2));
}
