import type { BomcpEnvelope } from "./bomcp/types.ts";
import type {
  ActiveExecutionResponse,
  CancelExecutionResponse,
  ExecutionRequest,
  HealthResponse
} from "./types.ts";
import type { SyncRunResult } from "./api/sync-response.ts";

// ---------------------------------------------------------------------------
// Options and errors
// ---------------------------------------------------------------------------

export interface BoClientOptions {
  url?: string;
  fetchImpl?: typeof fetch;
}

export class BoStaffClientHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "BoStaffClientHttpError";
    this.status = status;
    this.body = body;
  }
}

export class BoStaffClientStreamError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "BoStaffClientStreamError";
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Run options (Layer 0/1)
// ---------------------------------------------------------------------------

export interface RunOptions {
  backend?: string;
  continuation?: { backend: string; token: string };
  workspace?: string;
  model?: string;
  timeout?: number;
  reasoning?: string;
  objective?: string;
  constraints?: string[];
  context?: Record<string, unknown>;
  attachments?: unknown[];
  output?: Record<string, unknown>;
  stream?: boolean;
  verbose?: boolean;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// BoClient — the ergonomic API
// ---------------------------------------------------------------------------

export class BoClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BoClientOptions = {}) {
    this.baseUrl = (options.url ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  // -------------------------------------------------------------------------
  // Layer 0/1: sync run
  // -------------------------------------------------------------------------

  async run(prompt: string, opts: RunOptions = {}): Promise<SyncRunResult> {
    const body = { prompt, ...opts, stream: false };
    const response = await this.fetchImpl(`${this.baseUrl}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new BoStaffClientHttpError(
        extractHttpErrorMessage(text, response.status, response.statusText),
        response.status,
        parseMaybeJson(text),
      );
    }
    return JSON.parse(text) as SyncRunResult;
  }

  // -------------------------------------------------------------------------
  // Layer 0/1: streaming run
  // -------------------------------------------------------------------------

  async *stream(prompt: string, opts: RunOptions = {}): AsyncGenerator<BomcpEnvelope, void, void> {
    const body = { prompt, ...opts, stream: true };
    yield* this.streamNdjson(`${this.baseUrl}/run`, body);
  }

  // -------------------------------------------------------------------------
  // Layer 2: direct streaming (full ExecutionRequest)
  // -------------------------------------------------------------------------

  async *executeStream(request: ExecutionRequest): AsyncGenerator<BomcpEnvelope, void, void> {
    yield* this.streamNdjson(`${this.baseUrl}/executions/stream`, request);
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  async getExecution(executionId: string): Promise<ActiveExecutionResponse | undefined> {
    try {
      return await this.json<ActiveExecutionResponse>("GET", `/executions/${enc(executionId)}`);
    } catch (err) {
      if (err instanceof BoStaffClientHttpError && err.status === 404) return undefined;
      throw err;
    }
  }

  async cancelExecution(executionId: string): Promise<CancelExecutionResponse> {
    return this.json<CancelExecutionResponse>("POST", `/executions/${enc(executionId)}/cancel`);
  }

  async health(): Promise<HealthResponse> {
    return this.json<HealthResponse>("GET", "/health");
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async json<T = unknown>(method: string, pathname: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = parseMaybeJson(text);
    if (!response.ok) {
      throw new BoStaffClientHttpError(
        isErrorBody(parsed) ? parsed.error.message : (text.trim() || `${response.status} ${response.statusText}`),
        response.status,
        parsed,
      );
    }
    return parsed as T;
  }

  private async *streamNdjson(url: string, body: unknown): AsyncGenerator<BomcpEnvelope, void, void> {
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok || !response.body) {
      const text = await response.text();
      throw new BoStaffClientHttpError(
        extractHttpErrorMessage(text, response.status, response.statusText),
        response.status,
        parseMaybeJson(text),
      );
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) yield parseEnvelope(line);
          nl = buffer.indexOf("\n");
        }
      }
      const remainder = buffer.trim();
      if (remainder) yield parseEnvelope(remainder);
    } catch (err) {
      if (err instanceof BoStaffClientStreamError) throw err;
      throw new BoStaffClientStreamError("Failed while reading stream", err);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBo(opts?: BoClientOptions): BoClient {
  return new BoClient(opts);
}

// Convenience aliases
export { BoClient as BoStaffClient };
export type { BoClientOptions as BoStaffClientOptions };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function enc(s: string): string {
  return encodeURIComponent(s);
}

function extractHttpErrorMessage(text: string, status: number, statusText: string): string {
  const parsed = parseMaybeJson(text);
  return isErrorBody(parsed) ? parsed.error.message : (text.trim() || `${status} ${statusText}`);
}

function parseMaybeJson(text: string): unknown {
  if (!text.trim()) return null;
  try { return JSON.parse(text); } catch { return { error: { code: "invalid_json_response", message: text.trim() } }; }
}

function isErrorBody(value: unknown): value is { error: { message: string } } {
  return Boolean(value) && typeof value === "object" && typeof (value as { error?: { message?: unknown } }).error?.message === "string";
}

function parseEnvelope(line: string): BomcpEnvelope {
  try { return JSON.parse(line) as BomcpEnvelope; } catch (err) { throw new BoStaffClientStreamError(`Malformed NDJSON envelope: ${line.slice(0, 200)}`, err); }
}
