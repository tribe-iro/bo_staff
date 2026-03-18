export type UpstreamErrorKind = "runtime" | "rate_limit" | "auth";

export class UpstreamRuntimeError extends Error {
  readonly httpStatus: number;
  readonly kind: UpstreamErrorKind;
  readonly retryAfterMs?: number;

  constructor(message: string, httpStatus = 502, kind: UpstreamErrorKind = "runtime", retryAfterMs?: number) {
    super(message);
    this.name = "UpstreamRuntimeError";
    this.httpStatus = httpStatus;
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

export class RequestResolutionError extends Error {
  readonly httpStatus: number;
  readonly code: string;

  constructor(message: string, code = "validation_error", httpStatus = 400) {
    super(message);
    this.name = "RequestResolutionError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
