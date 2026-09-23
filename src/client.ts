// TypeScript SDK for bo /v1. Sugar (string input/workspace) is expanded here; the wire only sees canonical shapes.

import type { EngineInfo, Item, Part, Response, Run, RunSpec, Session, StreamEvent } from "./model.ts";
import { TERMINAL } from "./model.ts";
import { isProblem, type Problem } from "./problems.ts";

/** `RunSpec`, plus `input` and `workspace` as plain strings. */
export type SugarSpec = Omit<RunSpec, "input" | "workspace"> & {
  input: string | Part[];
  workspace: string | RunSpec["workspace"];
};

export class BoProblem extends Error {
  readonly problem: Problem;
  constructor(problem: Problem) {
    super(`${problem.title}: ${problem.detail}`);
    this.problem = problem;
  }
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];

/** HTTP plumbing shared by `Bo` and `RunHandle`; not exported. */
class Transport {
  readonly url: string;
  private readonly token?: string;

  constructor(url: string, token: string | undefined) {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
  }

  async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.send(path, {
      method,
      headers: { ...this.auth(), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw await failureOf(res);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async stream(path: string, headers: Record<string, string>, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const res = await this.send(path, { headers: { ...this.auth(), accept: "text/event-stream", ...headers }, signal });
    if (!res.ok || !res.body) throw await failureOf(res);
    return res.body;
  }

  private async send(path: string, init: RequestInit): Promise<globalThis.Response> {
    try {
      return await fetch(`${this.url}${path}`, init);
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause;
      if (cause?.code === "ECONNREFUSED") throw new Error(`no bo server at ${this.url}; start one with \`bo serve\``);
      throw err;
    }
  }

  private auth(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }
}

/** A `BoProblem` for problem+json bodies; otherwise a plain error that never leaks a parser failure. */
async function failureOf(res: globalThis.Response): Promise<Error> {
  const text = await res.text().catch(() => "");
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
  return isProblem(parsed) ? new BoProblem(parsed) : new Error(`${res.status} ${text.slice(0, 200)}`.trim());
}

export class Bo {
  private readonly transport: Transport;

  constructor(opts: { url?: string; token?: string } = {}) {
    this.transport = new Transport(opts.url ?? process.env.BO_URL ?? "http://127.0.0.1:3000", opts.token ?? process.env.BO_TOKEN);
  }

  get url(): string {
    return this.transport.url;
  }

  engines(): Promise<EngineInfo[]> {
    return this.transport.request("GET", "/v1/engines");
  }

  async run(spec: SugarSpec, opts: { idempotencyKey?: string } = {}): Promise<RunHandle> {
    const run = await this.transport.request<Run>("POST", "/v1/runs", expand(spec), opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {});
    return new RunHandle(this.transport, run);
  }

  readonly runs = {
    get: async (id: string): Promise<RunHandle> => new RunHandle(this.transport, await this.transport.request<Run>("GET", runPath(id))),
    list: (): Promise<Run[]> => this.transport.request("GET", "/v1/runs"),
  };

  readonly sessions = {
    /** Newest first; one workspace (an absolute path on the server's machine), or all. */
    list: (workspace?: string): Promise<Session[]> =>
      this.transport.request("GET", `/v1/sessions${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`),
  };
}

export class RunHandle {
  readonly id: string;
  run: Run;
  private readonly transport: Transport;

  constructor(transport: Transport, run: Run) {
    this.transport = transport;
    this.id = run.id;
    this.run = run;
  }

  /** Server-sent events, resuming with Last-Event-ID across disconnects (5 attempts, exponential backoff). */
  async *events(opts: { after?: number; signal?: AbortSignal } = {}): AsyncGenerator<StreamEvent> {
    let last = opts.after ?? 0;
    let attempt = 0;
    for (;;) {
      try {
        const body = await this.transport.stream(`${runPath(this.id)}/events`, last ? { "last-event-id": String(last) } : {}, opts.signal);
        for await (const e of parseSse(body)) {
          attempt = 0;
          if ("id" in e) last = e.id;
          if (e.event === "run") this.run = e.data;
          yield e;
          if (e.event === "run" && TERMINAL.has(e.data.status)) return;
        }
      } catch (err) {
        if (err instanceof BoProblem || opts.signal?.aborted || attempt >= BACKOFF_MS.length) throw err;
      }
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt++] ?? BACKOFF_MS.at(-1)));
    }
  }

  /** Drains events and returns the terminal Run. */
  async done(opts: { signal?: AbortSignal; onItem?: (item: Item, run: RunHandle) => void | Promise<void> } = {}): Promise<Run> {
    for await (const e of this.events(opts)) {
      if (e.event === "item" && opts.onItem) await opts.onItem(e.data, this);
    }
    return this.run;
  }

  message(content: string | Part[]): Promise<void> {
    return this.transport.request("POST", `${runPath(this.id)}/messages`, { content: typeof content === "string" ? [{ kind: "text", text: content }] : content });
  }

  respond(itemId: string, response: Response): Promise<void> {
    return this.transport.request("POST", `${runPath(this.id)}/items/${encodeURIComponent(itemId)}/response`, response);
  }

  cancel(): Promise<void> {
    return this.transport.request("POST", `${runPath(this.id)}/cancel`);
  }
}

function runPath(id: string): string {
  return `/v1/runs/${encodeURIComponent(id)}`;
}

export function expand(spec: SugarSpec): RunSpec {
  return {
    ...spec,
    input: typeof spec.input === "string" ? [{ kind: "text", text: spec.input }] : spec.input,
    workspace: typeof spec.workspace === "string" ? { root: spec.workspace } : spec.workspace,
  };
}

/** Minimal SSE parser (id/event/data fields, comment lines ignored). */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let id: number | undefined;
  let event = "message";
  let data: string[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let start = 0;
    for (let nl = buffer.indexOf("\n", start); nl >= 0; nl = buffer.indexOf("\n", start)) {
      const line = buffer.charCodeAt(nl - 1) === 13 ? buffer.slice(start, nl - 1) : buffer.slice(start, nl);
      start = nl + 1;
      if (line === "") {
        if (data.length) {
          const payload = JSON.parse(data.join("\n")) as unknown;
          yield (id === undefined ? { event, data: payload } : { event, id, data: payload }) as StreamEvent;
        }
        id = undefined; event = "message"; data = [];
      } else if (line.startsWith(":")) {
        continue;
      } else {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + (line.charCodeAt(colon + 1) === 32 ? 2 : 1));
        if (field === "id") id = Number(value);
        else if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
    }
    // One slice per chunk instead of one per line.
    buffer = buffer.slice(start);
  }
}
