export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
  };
}

export function parseJsonRpcRequestLine(
  line: string,
): { ok: true; request: JsonRpcRequest } | { ok: false; response: JsonRpcErrorResponse; logMessage: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return {
      ok: false,
      response: jsonRpcError(null, -32700, "Parse error"),
      logMessage: `invalid JSON-RPC payload: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      response: jsonRpcError(null, -32600, "Invalid Request"),
      logMessage: "invalid JSON-RPC request: expected object payload",
    };
  }

  const record = parsed as Record<string, unknown>;
  const id = parseId(record.id);
  if (record.jsonrpc !== "2.0" || typeof record.method !== "string" || record.method.trim() === "") {
    return {
      ok: false,
      response: jsonRpcError(id, -32600, "Invalid Request"),
      logMessage: "invalid JSON-RPC request: expected jsonrpc=2.0 and non-empty method",
    };
  }

  return {
    ok: true,
    request: {
      jsonrpc: "2.0",
      id,
      method: record.method,
      params: record.params,
    },
  };
}

export function parseToolCallParams(
  value: unknown,
): { ok: true; name: string; arguments_: unknown } | { ok: false; response: JsonRpcErrorResponse } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, response: jsonRpcError(null, -32602, "Invalid params: expected object") };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.trim() === "") {
    return { ok: false, response: jsonRpcError(null, -32602, "Invalid params: name is required") };
  }
  return {
    ok: true,
    name: record.name,
    arguments_: record.arguments ?? {},
  };
}

export function jsonRpcError(id: JsonRpcId, code: number, message: string): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

export function jsonRpcSuccess(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function parseId(value: unknown): JsonRpcId {
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  return null;
}
