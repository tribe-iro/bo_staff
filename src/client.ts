import type {
  BoStaffEvent,
  ExecutionRequest,
  ExecutionResponse,
  GatewayHttpResponse,
  SessionListResponse,
  SessionRecordSummary
} from "./types.ts";

export interface BoStaffClientOptions {
  baseUrl?: string;
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

export class BoStaffClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BoStaffClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async health(): Promise<unknown> {
    return this.request("GET", "/health");
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResponse> {
    return this.request("POST", "/executions", request);
  }

  async executeWithMetadata(request: ExecutionRequest): Promise<GatewayHttpResponse<ExecutionResponse>> {
    return this.requestWithMetadata("POST", "/executions", request);
  }

  // Streaming keeps HTTP 200 once the NDJSON transport is established. Callers must inspect the
  // terminal event to determine execution success or failure; only transport/setup failures throw.
  async *executeStream(request: ExecutionRequest): AsyncGenerator<BoStaffEvent, void, void> {
    const response = await this.fetchImpl(`${this.baseUrl}/executions/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    if (!response.ok || !response.body) {
      const text = await response.text();
      throw new BoStaffClientHttpError(
        extractHttpErrorMessage(text, response.status, response.statusText),
        response.status,
        parseMaybeJson(text)
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) {
            yield parseStreamEvent(line);
          }
          newlineIndex = buffer.indexOf("\n");
        }
      }
      const remainder = buffer.trim();
      if (remainder) {
        yield parseStreamEvent(remainder);
      }
    } catch (error) {
      throw error instanceof BoStaffClientStreamError
        ? error
        : new BoStaffClientStreamError("Failed while reading execution stream", error);
    }
  }

  async listSessions(input?: { limit?: number; cursor?: string }): Promise<SessionListResponse> {
    const search = new URLSearchParams();
    if (typeof input?.limit === "number" && Number.isInteger(input.limit) && input.limit > 0) {
      search.set("limit", String(input.limit));
    }
    if (typeof input?.cursor === "string" && input.cursor.length > 0) {
      search.set("cursor", input.cursor);
    }
    const pathname = search.size > 0 ? `/sessions?${search.toString()}` : "/sessions";
    return this.request("GET", pathname);
  }

  async getSession(handle: string): Promise<{ session: SessionRecordSummary } | undefined> {
    try {
      return await this.request("GET", `/sessions/${encodeURIComponent(handle)}`);
    } catch (error) {
      if (error instanceof BoStaffClientHttpError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async deleteSession(handle: string): Promise<{ deleted: boolean; handle: string }> {
    return this.request("DELETE", `/sessions/${encodeURIComponent(handle)}`);
  }

  async getExecution(executionId: string): Promise<{ execution: ExecutionResponse } | undefined> {
    try {
      return await this.request("GET", `/executions/${encodeURIComponent(executionId)}`);
    } catch (error) {
      if (error instanceof BoStaffClientHttpError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async getExecutionEvents(executionId: string): Promise<{ events: BoStaffEvent[] } | undefined> {
    try {
      return await this.request("GET", `/executions/${encodeURIComponent(executionId)}/events`);
    } catch (error) {
      if (error instanceof BoStaffClientHttpError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async cancelExecution(executionId: string): Promise<{ cancelled: boolean; execution_id: string }> {
    return this.request("POST", `/executions/${encodeURIComponent(executionId)}/cancel`);
  }

  private async request<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    const response = await this.requestWithMetadata<T>(method, pathname, body);
    return response.body;
  }

  private async requestWithMetadata<T>(method: string, pathname: string, body?: unknown): Promise<GatewayHttpResponse<T>> {
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    const parsed = parseMaybeJson(text);
    if (!response.ok) {
      const message = isErrorBody(parsed)
        ? parsed.error.message
        : (text.trim() || `${response.status} ${response.statusText}`);
      throw new BoStaffClientHttpError(message, response.status, parsed);
    }
    const headers = Object.fromEntries(response.headers.entries());
    return {
      body: parsed as T,
      http_status: response.status,
      headers,
      request_id: headers["x-request-id"]
    };
  }
}

function extractHttpErrorMessage(text: string, status: number, statusText: string): string {
  const parsed = parseMaybeJson(text);
  return isErrorBody(parsed)
    ? parsed.error.message
    : (text.trim() || `${status} ${statusText}`);
}

function parseMaybeJson(text: string): unknown {
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return {
      error: {
        code: "invalid_json_response",
        message: text.trim()
      }
    };
  }
}

function isErrorBody(value: unknown): value is { error: { message: string } } {
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as { error?: { message?: unknown } }).error?.message === "string";
}

function parseStreamEvent(line: string): BoStaffEvent {
  try {
    return JSON.parse(line) as BoStaffEvent;
  } catch (error) {
    throw new BoStaffClientStreamError(`Malformed NDJSON event: ${line.slice(0, 200)}`, error);
  }
}
