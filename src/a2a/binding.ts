import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import {
  Role, TaskState,
  type AgentCard, type Artifact, type CancelTaskRequest, type DeleteTaskPushNotificationConfigRequest,
  type GetExtendedAgentCardRequest, type GetTaskPushNotificationConfigRequest, type GetTaskRequest,
  type ListTaskPushNotificationConfigsRequest, type ListTaskPushNotificationConfigsResponse,
  type ListTasksRequest, type ListTasksResponse, type Message, type Part as A2aPart,
  type SendMessageRequest, type StreamResponse, type SubscribeToTaskRequest, type Task,
  type TaskPushNotificationConfig, type TaskStatus,
} from "@a2a-js/sdk";
import { JsonRpcTransportHandler, ServerCallContext, type A2ARequestHandler } from "@a2a-js/sdk/server";
import {
  ContentTypeNotSupportedError, ExtendedAgentCardNotConfiguredError, PushNotificationNotSupportedError,
  RequestMalformedError, TaskNotCancelableError, TaskNotFoundError, UnsupportedOperationError, VersionNotSupportedError,
} from "@a2a-js/sdk/errors";
import type { Subscription } from "../core/runs.ts";
import {
  ENGINE_IDS, IMAGE_MEDIA_TYPES, TERMINAL,
  type EngineInfo, type ImageMediaType, type Item, type Part, type ResultPart, type Run, type RunStatus, type StreamEvent,
} from "../model.ts";
import { isProblem, problemName, type Problem } from "../problems.ts";
import { parseResponse, resolveSpec } from "../spec.ts";
import type { Body, Context } from "../http/context.ts";
import { endSse, openSse, writeBackpressured } from "../http/sse.ts";
import { A2A_VERSION, BO_EXTENSION, agentCard } from "./card.ts";

type Obj = Record<string, unknown>;

const STATE: Record<RunStatus, TaskState> = {
  running: TaskState.TASK_STATE_WORKING,
  waiting: TaskState.TASK_STATE_INPUT_REQUIRED,
  completed: TaskState.TASK_STATE_COMPLETED,
  failed: TaskState.TASK_STATE_FAILED,
  cancelled: TaskState.TASK_STATE_CANCELED,
};

const DISCONNECT = "disconnect";

export class A2aService implements A2ARequestHandler {
  /** Run → the A2A context it was started in (runs are retained in memory; so is this projection). */
  private readonly runContext = new Map<string, string>();
  private readonly transport = new JsonRpcTransportHandler(this);
  private readonly ctx: Context;
  private readonly env: NodeJS.ProcessEnv;
  private readonly base: () => string;
  private readonly bearer: boolean;

  constructor(ctx: Context, env: NodeJS.ProcessEnv, base: () => string, bearer: boolean) {
    this.ctx = ctx;
    this.env = env;
    this.base = base;
    this.bearer = bearer;
  }

  agentCard(): AgentCard {
    const infos = ENGINE_IDS.map((id) => this.ctx.engines.cached(id)).filter((info): info is EngineInfo => info !== undefined);
    return agentCard(this.base(), infos, this.bearer);
  }

  async route(req: IncomingMessage, res: ServerResponse, body: () => Promise<Body>): Promise<void> {
    const parsed = await body();
    const raw = "raw" in parsed ? parsed.raw : undefined;
    const requestedVersion = header(req, "a2a-version");
    const disconnect = new AbortController();
    res.once("close", () => disconnect.abort());
    const call = new ServerCallContext({
      requestedVersion,
      requestedExtensions: splitHeader(req, "a2a-extensions"),
      state: new Map<string, unknown>([["headers", req.headers], [DISCONNECT, disconnect.signal]]),
    });
    // Activate before dispatch: a streaming handler body only runs after the response headers are written.
    if (usesBo(call)) call.addActivatedExtension(BO_EXTENSION);
    let response: Awaited<ReturnType<JsonRpcTransportHandler["handle"]>>;
    if ("problem" in parsed) {
      // JSON-RPC 2.0: -32700 for a body that is not JSON, -32600 for any other unusable request body.
      const code = problemName(parsed.problem) === "invalid_json" ? -32700 : -32600;
      response = { jsonrpc: "2.0", id: null, error: { code, message: parsed.problem.detail } };
    } else if (requestedVersion !== A2A_VERSION) {
      response = { jsonrpc: "2.0", id: rpcId(raw), error: JsonRpcTransportHandler.mapToJSONRPCError(new VersionNotSupportedError(`use A2A-Version ${A2A_VERSION}`)) };
    } else response = await this.transport.handle(raw as Obj, call);
    if (call.activatedExtensions?.length) res.setHeader("a2a-extensions", call.activatedExtensions.join(", "));
    const notification = isObj(raw) && !("id" in raw);
    if (isAsyncGenerator(response)) {
      if (notification) {
        for await (const _event of response) { /* execute notification without a response */ }
        res.writeHead(204).end();
        return;
      }
      openSse(res);
      for await (const event of response) if (!await writeBackpressured(res, `data: ${JSON.stringify(event)}\n\n`)) break;
      await endSse(res);
      return;
    }
    if (notification) { res.writeHead(204).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(response));
  }

  async getAgentCard(): Promise<AgentCard> { return this.agentCard(); }
  async getAuthenticatedExtendedAgentCard(_params: GetExtendedAgentCardRequest, _context: ServerCallContext): Promise<AgentCard> {
    throw new ExtendedAgentCardNotConfiguredError();
  }

  async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Task | Message> {
    const run = await this.start(params, context);
    if (params.configuration?.returnImmediately) return this.task(run, context, true);
    return this.task(await this.settle(run.id, context), context, true);
  }

  async *sendMessageStream(params: SendMessageRequest, context: ServerCallContext): AsyncGenerator<StreamResponse, void, undefined> {
    const run = await this.start(params, context);
    yield* this.stream(run.id, context);
  }

  async getTask(params: GetTaskRequest, context: ServerCallContext): Promise<Task> {
    return this.task(this.mustRun(params.id), context, true);
  }

  async cancelTask(params: CancelTaskRequest, context: ServerCallContext): Promise<Task> {
    const run = this.mustRun(params.id);
    if (TERMINAL.has(run.status)) throw new TaskNotCancelableError(`task ${run.id} is ${run.status}`);
    raise(this.ctx.runs.cancel(run.id));
    return this.task(this.mustRun(run.id), context, true);
  }

  async listTasks(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    this.prune();
    const pageSize = Math.max(1, Math.min(100, params.pageSize ?? 50));
    const after = parseTimestamp(params.statusTimestampAfter);
    const cursor = decodeCursor(params.pageToken);
    let runs = this.ctx.runs.list().filter((run) =>
      (!params.contextId || this.contextOf(run.id) === params.contextId)
      && (!params.status || STATE[run.status] === params.status)
      && (after === undefined || Date.parse(run.ended_at ?? run.created_at) >= after));
    runs.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    const totalSize = runs.length;
    if (cursor) runs = runs.filter((run) => run.created_at < cursor.createdAt || (run.created_at === cursor.createdAt && run.id < cursor.id));
    const page = runs.slice(0, pageSize);
    const last = page.at(-1);
    return {
      tasks: page.map((run) => this.task(run, context, params.includeArtifacts === true)),
      nextPageToken: runs.length > page.length && last ? encodeCursor(last) : "",
      pageSize,
      totalSize,
    };
  }

  async *resubscribe(params: SubscribeToTaskRequest, context: ServerCallContext): AsyncGenerator<StreamResponse, void, undefined> {
    this.mustRun(params.id);
    yield* this.stream(params.id, context);
  }

  async createTaskPushNotificationConfig(_params: TaskPushNotificationConfig): Promise<TaskPushNotificationConfig> { throw new PushNotificationNotSupportedError(); }
  async getTaskPushNotificationConfig(_params: GetTaskPushNotificationConfigRequest): Promise<TaskPushNotificationConfig> { throw new PushNotificationNotSupportedError(); }
  async listTaskPushNotificationConfigs(_params: ListTaskPushNotificationConfigsRequest): Promise<ListTaskPushNotificationConfigsResponse> { throw new PushNotificationNotSupportedError(); }
  async deleteTaskPushNotificationConfig(_params: DeleteTaskPushNotificationConfigRequest): Promise<void> { throw new PushNotificationNotSupportedError(); }

  /** Starts a run for a new message, or answers/steers the run named by `message.taskId`. */
  private async start(params: SendMessageRequest, context: ServerCallContext): Promise<Run> {
    this.prune();
    const message = params.message;
    if (!message || !message.messageId || message.role !== Role.ROLE_USER || !message.parts.length) {
      throw new RequestMalformedError("a user message with messageId and parts is required");
    }
    if (message.taskId) return this.continueTask(message);

    const contextId = message.contextId || `ctx_${randomUUID()}`;
    const spec: Obj = { ...(usesBo(context) ? extensionSpec(params, message) : undefined) };
    if (spec.workspace === undefined) {
      if (!this.env.BO_A2A_WORKSPACE) throw new RequestMalformedError(`workspace required in ${BO_EXTENSION} metadata or BO_A2A_WORKSPACE`);
      spec.workspace = { root: this.env.BO_A2A_WORKSPACE };
    }
    spec.input = fromA2aParts(message.parts);
    // A context is a conversation: it continues its latest session (durable, like any session) unless the caller
    // chose one explicitly.
    const latest = this.ctx.sessions.latest({ context: contextId });
    if (latest && spec.session === undefined) spec.session = { id: latest.id };
    const resolved = await resolveSpec(spec, this.ctx.engines, this.ctx.sessions);
    if ("problem" in resolved) raise(resolved.problem);
    const created = await this.ctx.runs.create(resolved.spec, { context: contextId });
    if ("problem" in created) raise(created.problem);
    this.runContext.set(created.run.id, contextId);
    return created.run;
  }

  private continueTask(message: Message): Run {
    const run = this.mustRun(message.taskId);
    if (message.contextId && this.contextOf(run.id) !== message.contextId) throw new RequestMalformedError("message context does not match task context");
    const answer = message.parts.find((part) => part.content?.$case === "data" && isObj(part.content.value) && typeof part.content.value.item_id === "string");
    if (answer?.content?.$case === "data") {
      const data = answer.content.value as Obj;
      const parsed = parseResponse(data.response);
      if ("problem" in parsed) raise(parsed.problem);
      raise(this.ctx.runs.respond(run.id, String(data.item_id), parsed.response));
    } else {
      raise(this.ctx.runs.message(run.id, fromA2aParts(message.parts)));
    }
    return this.mustRun(run.id);
  }

  /** Resolves once the run is terminal or waiting for input. */
  private async settle(runId: string, context: ServerCallContext): Promise<Run> {
    const observed = this.observe(runId, context);
    try {
      if (TERMINAL.has(observed.run.status) || observed.run.status === "waiting") return observed.run;
      for await (const event of observed.events) {
        if (event.event === "run" && (TERMINAL.has(event.data.status) || event.data.status === "waiting")) return event.data;
      }
      return this.mustRun(runId);
    } finally {
      observed.close();
    }
  }

  private async *stream(runId: string, context: ServerCallContext): AsyncGenerator<StreamResponse, void, undefined> {
    const observed = this.observe(runId, context);
    try {
      yield { payload: { $case: "task", value: this.task(observed.run, context, true) } };
      for await (const event of observed.events) yield* this.responses(event, context, runId);
    } finally {
      observed.close();
    }
  }

  /** Subscribes to a run; the subscription closes when the HTTP client disconnects. */
  private observe(runId: string, context: ServerCallContext): Subscription {
    const observed = this.ctx.runs.observe(runId);
    if (isProblem(observed)) raise(observed);
    const subscription: Subscription = observed;
    const signal = context.state.get(DISCONNECT) as AbortSignal | undefined;
    if (signal?.aborted) subscription.close();
    else signal?.addEventListener("abort", subscription.close, { once: true });
    return subscription;
  }

  private responses(event: StreamEvent, context: ServerCallContext, taskId: string): StreamResponse[] {
    if (event.event === "delta") return [];
    const contextId = this.contextOf(taskId);
    if (event.event === "item") {
      if (event.data.type === "message" && event.data.role === "user") return [];
      return [{ payload: { $case: "statusUpdate", value: {
        taskId, contextId,
        status: { state: TaskState.TASK_STATE_WORKING, message: itemMessage(event.data, taskId, contextId), timestamp: event.data.created_at },
        metadata: metadata(context, { item: event.data }),
      } } }];
    }
    const run = event.data;
    const status: StreamResponse = { payload: { $case: "statusUpdate", value: {
      taskId: run.id, contextId, status: taskStatus(run, contextId), metadata: metadata(context, { run }),
    } } };
    if (TERMINAL.has(run.status) && run.result) return [
      { payload: { $case: "artifactUpdate", value: { taskId: run.id, contextId, artifact: resultArtifact(run.result), append: false, lastChunk: true, metadata: undefined } } },
      status,
    ];
    return [status];
  }

  /** Pure projection of a run onto an A2A task. */
  private task(run: Run, context: ServerCallContext, includeArtifacts: boolean): Task {
    const contextId = this.contextOf(run.id);
    const pending = run.status === "waiting" ? this.ctx.runs.pending(run.id) : [];
    const status = taskStatus(run, contextId);
    if (pending.length) status.message = agentMessage(`${run.id}:pending`, run.id, contextId, pending.map(dataPart));
    return {
      id: run.id, contextId, status,
      artifacts: includeArtifacts && run.result ? [resultArtifact(run.result)] : [],
      history: [], metadata: metadata(context, { run }),
    };
  }

  /** Runs created through /v1 get a stable derived context. */
  private contextOf(runId: string): string {
    return this.runContext.get(runId) ?? `ctx_${runId}`;
  }

  private mustRun(id: string): Run {
    const run = id ? this.ctx.runs.get(id) : undefined;
    if (!run) throw new TaskNotFoundError(`task ${id} not found`);
    return run;
  }

  /** Forgets the context of runs the run manager no longer retains. */
  private prune(): void {
    for (const runId of this.runContext.keys()) if (!this.ctx.runs.get(runId)) this.runContext.delete(runId);
  }
}

/** Maps a bo problem onto the A2A error taxonomy. */
function raise(p: Problem): never;
function raise(p: Problem | undefined): void;
function raise(p: Problem | undefined): void {
  if (!p) return;
  const detail = p.errors?.length ? `${p.detail}: ${p.errors.map((e) => `${e.pointer || "/"} ${e.detail}`).join("; ")}` : p.detail;
  switch (problemName(p)) {
    case "run_not_found":
    case "item_not_found":
      throw new TaskNotFoundError(detail);
    case "too_many_runs":
    case "too_many_messages":
    case "too_many_subscribers":
    case "too_many_idempotency_keys":
    case "session_busy":
    case "not_accepting_messages":
    case "item_not_awaiting":
    case "unsupported_feature":
    case "engine_unavailable":
      throw new UnsupportedOperationError(detail);
    default:
      throw new RequestMalformedError(detail);
  }
}

function taskStatus(run: Run, contextId: string): TaskStatus {
  return {
    state: STATE[run.status], timestamp: run.ended_at ?? run.created_at,
    message: run.error ? agentMessage(`${run.id}:error`, run.id, contextId, [textPart(`${run.error.code}: ${run.error.message}`)]) : undefined,
  };
}

function agentMessage(messageId: string, taskId: string, contextId: string, parts: A2aPart[]): Message {
  return { messageId, contextId, taskId, role: Role.ROLE_AGENT, parts, metadata: undefined, extensions: [], referenceTaskIds: [] };
}

function itemMessage(item: Item, taskId: string, contextId: string): Message {
  return agentMessage(item.id, taskId, contextId, item.type === "message" ? item.content.map(toA2aContent) : [dataPart(item)]);
}

function resultArtifact(result: ResultPart): Artifact {
  return { artifactId: "result", name: "result", description: "", parts: [toA2aPart(result)], metadata: undefined, extensions: [] };
}

export function toA2aPart(part: ResultPart): A2aPart {
  return part.kind === "text" ? textPart(part.text) : dataPart(part.data);
}

/** Message content: images are described, never exposed as server paths. */
function toA2aContent(part: Part): A2aPart {
  return part.kind === "image" ? dataPart({ kind: "image", media_type: part.media_type }) : toA2aPart(part);
}

export function fromA2aParts(parts: A2aPart[]): Part[] {
  return parts.map((part): Part => {
    if (part.content?.$case === "text") return { kind: "text", text: part.content.value };
    if (part.content?.$case === "data") return { kind: "data", data: part.content.value };
    if (part.content?.$case === "url" && part.content.value.startsWith("file://") && IMAGE_MEDIA_TYPES.includes(part.mediaType as ImageMediaType)) {
      return { kind: "image", path: fileURLToPath(part.content.value), media_type: part.mediaType as ImageMediaType };
    }
    throw new ContentTypeNotSupportedError("only text, data, and file:// image parts are supported");
  });
}

function textPart(text: string): A2aPart { return { content: { $case: "text", value: text }, mediaType: "text/plain", filename: "", metadata: undefined }; }
function dataPart(data: unknown): A2aPart { return { content: { $case: "data", value: data }, mediaType: "application/json", filename: "", metadata: undefined }; }

function usesBo(context: ServerCallContext): boolean {
  return context.requestedExtensions?.includes(BO_EXTENSION) ?? false;
}

function metadata(context: ServerCallContext, value: Obj): Obj | undefined {
  return usesBo(context) ? { [BO_EXTENSION]: value } : undefined;
}

function extensionSpec(params: SendMessageRequest, message: Message): Obj | undefined {
  const fromMessage = message.metadata?.[BO_EXTENSION];
  const fromRequest = params.metadata?.[BO_EXTENSION];
  return isObj(fromMessage) ? fromMessage : isObj(fromRequest) ? fromRequest : undefined;
}

function encodeCursor(run: Run): string {
  return Buffer.from(JSON.stringify({ createdAt: run.created_at, id: run.id })).toString("base64url");
}

function decodeCursor(token: string): { createdAt: string; id: string } | undefined {
  if (!token) return undefined;
  try {
    const value = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Obj;
    if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.id !== "string" || !value.id) {
      throw new Error("shape");
    }
    return { createdAt: value.createdAt, id: value.id };
  } catch { throw new RequestMalformedError("invalid page token"); }
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new RequestMalformedError("invalid statusTimestampAfter");
  return timestamp;
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function splitHeader(req: IncomingMessage, name: string): string[] | undefined {
  const entries = header(req, name).split(",").map((item) => item.trim()).filter(Boolean);
  return entries.length ? entries : undefined;
}

function rpcId(value: unknown): string | number | null {
  return isObj(value) && (typeof value.id === "string" || typeof value.id === "number" || value.id === null) ? value.id : null;
}

function isObj(value: unknown): value is Obj { return !!value && typeof value === "object" && !Array.isArray(value); }
function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, void, undefined> { return isObj(value) && Symbol.asyncIterator in value; }
