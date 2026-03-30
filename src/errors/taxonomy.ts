export const ERROR_CODES = [
  "validation_failed",
  "unknown_backend",
  "invalid_limit",
  "invalid_cursor",
  "gateway_busy",
  "gateway_draining",
  "provider_process_error",
  "provider_timeout",
  "provider_rate_limit",
  "provider_auth_error",
  "provider_output_overflow",
  "provider_process_aborted",
  "provider_output_missing",
  "provider_output_invalid",
  "schema_validation_failed",
  "turn_limit_exceeded",
  "execution_cancelled",
  "client_disconnect_cancelled",
  "internal_error"
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_CATEGORIES = [
  "admission",
  "provider",
  "output",
  "resource",
  "workspace",
  "cancellation",
  "internal"
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export const ERROR_CODE_DEFINITIONS: Record<ErrorCode, {
  category: ErrorCategory;
  default_retryable: boolean;
}> = {
  validation_failed: { category: "admission", default_retryable: false },
  unknown_backend: { category: "admission", default_retryable: false },
  invalid_limit: { category: "admission", default_retryable: false },
  invalid_cursor: { category: "admission", default_retryable: false },
  gateway_busy: { category: "admission", default_retryable: true },
  gateway_draining: { category: "admission", default_retryable: true },
  provider_process_error: { category: "provider", default_retryable: true },
  provider_timeout: { category: "provider", default_retryable: true },
  provider_rate_limit: { category: "provider", default_retryable: true },
  provider_auth_error: { category: "provider", default_retryable: false },
  provider_output_overflow: { category: "provider", default_retryable: true },
  provider_process_aborted: { category: "provider", default_retryable: false },
  provider_output_missing: { category: "output", default_retryable: false },
  provider_output_invalid: { category: "output", default_retryable: false },
  schema_validation_failed: { category: "output", default_retryable: false },
  turn_limit_exceeded: { category: "resource", default_retryable: false },
  execution_cancelled: { category: "cancellation", default_retryable: false },
  client_disconnect_cancelled: { category: "cancellation", default_retryable: false },
  internal_error: { category: "internal", default_retryable: false }
};

export function buildExecutionError(
  code: ErrorCode,
  message: string,
  overrides?: {
    retryable?: boolean;
    details?: Record<string, unknown>;
  }
) {
  const definition = ERROR_CODE_DEFINITIONS[code];
  return {
    code,
    category: definition.category,
    message,
    retryable: overrides?.retryable ?? definition.default_retryable,
    details: overrides?.details
  };
}
