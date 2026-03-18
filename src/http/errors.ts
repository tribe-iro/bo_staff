import type { ServerResponse } from "node:http";

export class HttpRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    status: number,
    code: string,
    message: string
  ) {
    super(message);
    this.name = "HttpRequestError";
    this.status = status;
    this.code = code;
  }
}

export function writeJsonError(response: ServerResponse, input: {
  requestId: string;
  status: number;
  code: string;
  message: string;
}): void {
  response.writeHead(input.status, {
    "content-type": "application/json",
    "x-request-id": input.requestId
  });
  response.end(JSON.stringify({
    error: {
      code: input.code,
      message: input.message
    }
  }, null, 2));
}

export function writeNotFound(response: ServerResponse, requestId: string, message: string): void {
  writeJsonError(response, {
    requestId,
    status: 404,
    code: "not_found",
    message
  });
}
