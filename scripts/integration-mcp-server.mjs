import readline from "node:readline";

const marker = process.env.BO_STAFF_MCP_MARKER ?? "MCP-MARKER-MISSING";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (typeof message.id === "undefined" || typeof message.method !== "string") {
    return;
  }

  switch (message.method) {
    case "initialize":
      respond(message.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "bo-staff-integration-fixture",
          version: "1.0.0"
        }
      });
      return;
    case "tools/list":
      respond(message.id, {
        tools: [
          {
            name: "integration_marker",
            description: "Return the integration marker configured for this test run.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false
            }
          }
        ]
      });
      return;
    case "tools/call":
      if (message.params?.name === "integration_marker") {
        respond(message.id, {
          content: [
            {
              type: "text",
              text: marker
            }
          ],
          isError: false
        });
        return;
      }
      respondError(message.id, -32601, `Unknown tool: ${String(message.params?.name ?? "")}`);
      return;
    case "ping":
      respond(message.id, {});
      return;
    default:
      respondError(message.id, -32601, `Method not found: ${message.method}`);
  }
});

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}
