import type { ErrorCode } from "./errors/taxonomy.ts";

export type UpstreamErrorKind = "runtime" | "rate_limit" | "auth";

export class UpstreamRuntimeError extends Error {
  readonly httpStatus: number;
  readonly code: ErrorCode;
  readonly retryAfterMs?: number;

  constructor(message: string, httpStatus = 502, code: ErrorCode = "provider_process_error", retryAfterMs?: number) {
    super(message);
    this.name = "UpstreamRuntimeError";
    this.httpStatus = httpStatus;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export class RequestResolutionError extends Error {
  readonly httpStatus: number;
  readonly code: ErrorCode;

  constructor(message: string, code: ErrorCode = "validation_failed", httpStatus = 400) {
    super(message);
    this.name = "RequestResolutionError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
