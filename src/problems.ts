import type { ServerResponse } from "node:http";

const STATUS = {
  invalid_spec: 422, invalid_request: 422, unsupported_feature: 422, engine_unavailable: 422,
  idempotency_mismatch: 422, wrong_response_kind: 422,
  session_busy: 409, item_not_awaiting: 409, not_accepting_messages: 409,
  run_not_found: 404, item_not_found: 404, session_not_found: 404, not_found: 404,
  too_many_runs: 429, too_many_messages: 429, too_many_subscribers: 429, too_many_idempotency_keys: 429,
  unauthorized: 401, forbidden_host: 403, method_not_allowed: 405, unsupported_media_type: 415, payload_too_large: 413, invalid_json: 400,
  internal: 500, unavailable: 503,
} as const satisfies Record<string, number>;

export type ProblemName = keyof typeof STATUS;

const PREFIX = "urn:bo:problem:";

export interface FieldError { pointer: string; detail: string }

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  errors?: FieldError[];
}

export function problem(name: ProblemName, detail: string, errors?: FieldError[]): Problem {
  return {
    type: `${PREFIX}${name}`,
    title: name.replaceAll("_", " "),
    status: STATUS[name],
    detail,
    ...(errors?.length ? { errors } : {}),
  };
}

export function problemName(p: Problem): ProblemName {
  return p.type.slice(PREFIX.length) as ProblemName;
}

export function isProblem(v: unknown): v is Problem {
  return typeof v === "object" && v !== null && typeof (v as Problem).type === "string" && (v as Problem).type.startsWith(PREFIX);
}

export function writeProblem(res: ServerResponse, p: Problem, headers: Record<string, string> = {}): void {
  res.writeHead(p.status, {
    "content-type": "application/problem+json",
    ...(p.status === 429 || p.status === 503 ? { "retry-after": "5" } : {}),
    ...headers,
  }).end(JSON.stringify(p));
}
