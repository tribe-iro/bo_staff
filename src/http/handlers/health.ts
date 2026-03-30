import type { ServerResponse } from "node:http";
import type { BoStaff } from "../../gateway.ts";
import type { HealthResponse } from "../../types.ts";

export async function handleHealth(response: ServerResponse, gateway: BoStaff, requestId: string): Promise<void> {
  const body: HealthResponse = await gateway.health();
  response.writeHead(200, {
    "content-type": "application/json",
    "x-request-id": requestId
  });
  response.end(JSON.stringify(body, null, 2));
}
