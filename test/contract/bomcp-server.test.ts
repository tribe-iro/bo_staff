import test from "node:test";
import assert from "node:assert/strict";
import { parseJsonRpcRequestLine, parseToolCallParams } from "../../src/bomcp/jsonrpc.ts";

test("parseJsonRpcRequestLine returns a JSON-RPC parse error for malformed JSON", () => {
  const result = parseJsonRpcRequestLine("{bad json");
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("expected parse failure");
  }
  assert.equal(result.response.error.code, -32700);
  assert.equal(result.response.id, null);
});

test("parseJsonRpcRequestLine rejects invalid JSON-RPC request shapes", () => {
  const result = parseJsonRpcRequestLine(JSON.stringify({ jsonrpc: "2.0", id: "req_1" }));
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("expected invalid request");
  }
  assert.equal(result.response.error.code, -32600);
});

test("parseToolCallParams rejects missing tool names", () => {
  const result = parseToolCallParams({ arguments: { phase: "scan" } });
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("expected invalid params");
  }
  assert.equal(result.response.error.code, -32602);
});

test("parseToolCallParams extracts valid tool call fields", () => {
  const result = parseToolCallParams({ name: "bomcp.progress.update", arguments: { phase: "scan" } });
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("expected valid tool params");
  }
  assert.equal(result.name, "bomcp.progress.update");
  assert.deepEqual(result.arguments_, { phase: "scan" });
});
