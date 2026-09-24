// bo as an ACP v1 agent. It talks to the bo server through the TypeScript client, like the CLI: never to engines.
// One ACP session is a bo session (continued by key, or by id); one `session/prompt` is one bo run.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { Bo, RunHandle } from "../client.ts";
import { BoProblem } from "../client.ts";
import { MAX_IMAGE_BYTES } from "../contract/schema.ts";
import { shapeErrors } from "../contract/validate.ts";
import { TERMINAL, type EngineId, type EngineInfo, type Item, type Part, type Response, type RunSpec, type Session as BoSession, type SessionRun } from "../model.ts";
import { summary } from "../format.ts";
import { VERSION } from "../version.ts";
import {
  answersFrom, configOptions, mcpServers, modes, modeState, optionValues, PERMISSION_OPTIONS, planUpdate, promptParts, questionForm,
  text, toolCall, usage, type Choice, type ModeId,
} from "./map.ts";

/** The RunSpec fields ACP has no word for, accepted in `_meta.bo` on session/new and session/resume. */
const META_FIELDS = ["instructions", "project_instructions", "skills", "subagents", "limits", "env", "timeout_s"] as const;
type MetaSpec = Pick<RunSpec, (typeof META_FIELDS)[number]>;

export interface AcpDefaults { engine?: EngineId; model?: string; effort?: string; access?: "read" | "write" | "full" }

interface Session {
  id: string;
  /** How the next run continues it: by key (sessions started here) or by bo id (resumed from elsewhere). */
  ref: { key: string } | { id: string };
  cwd: string;
  extraRoots: string[];
  mcp: RunSpec["mcp"];
  meta: MetaSpec;
  choice: Choice;
  /** The engine is fixed once a run has started the session. */
  pinned: boolean;
  active?: RunHandle;
  /** The images of the turn in progress (its prompt's and its steering messages'). */
  images?: Images;
  /** Prompts wait here in order; one run at a time. */
  queue: Promise<unknown>;
  /** Bumped by session/cancel: queued prompts from before it return `cancelled`. */
  epoch: number;
}

export class BoAcpAgent implements acp.Agent {
  private readonly conn: acp.AgentSideConnection;
  private readonly bo: Bo;
  private readonly defaults: AcpDefaults;
  private readonly root: boolean;
  private readonly sessions = new Map<string, Session>();
  private client: acp.ClientCapabilities = {};
  /** This process's private directory for prompt images, made when the first one arrives. */
  private imageDir?: Promise<string>;

  constructor(conn: acp.AgentSideConnection, bo: Bo, defaults: AcpDefaults = {}) {
    this.conn = conn;
    this.bo = bo;
    this.defaults = defaults;
    this.root = process.getuid?.() === 0;
  }

  async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    this.client = params.clientCapabilities ?? {};
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: "bo", title: "bo (Claude Code and Codex)", version: VERSION },
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true },
        sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {}, additionalDirectories: {} },
        _meta: { steering: { supported: true }, promptQueueing: true },
      },
    };
  }

  async authenticate(): Promise<acp.AuthenticateResponse> {
    return {};
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const engines = await this.engines();
    const id = `acp:${randomUUID()}`;
    const session = this.open(id, { key: id }, params, engines, false);
    return { sessionId: id, configOptions: configOptions(engines, session.choice, this.root), modes: modeState(session.choice, this.root) };
  }

  async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
    const { session, engines } = await this.reopen(params);
    return { configOptions: configOptions(engines, session.choice, this.root), modes: modeState(session.choice, this.root) };
  }

  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    const { session, engines, known } = await this.reopen(params);
    if (known) for (const run of await this.bo.sessions.runs(known.id)) await this.replay(session.id, run);
    return { configOptions: configOptions(engines, session.choice, this.root), modes: modeState(session.choice, this.root) };
  }

  async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    const all = await this.bo.sessions.list(params.cwd ?? undefined);
    const offset = params.cursor ? Number(Buffer.from(params.cursor, "base64url").toString()) || 0 : 0;
    const page = all.slice(offset, offset + 50);
    return {
      sessions: page.map((s) => ({ sessionId: s.key ?? s.id, cwd: s.workspace, title: s.title, updatedAt: s.updated_at })),
      ...(offset + 50 < all.length ? { nextCursor: Buffer.from(String(offset + 50)).toString("base64url") } : {}),
    };
  }

  async closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
    await this.cancel(params);
    this.sessions.delete(params.sessionId);
    return {};
  }

  /** Its run in progress ends first (bo refuses to forget a session a run still holds); a gone session is deleted. */
  async deleteSession(params: acp.DeleteSessionRequest): Promise<acp.DeleteSessionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (session) {
      await this.cancel(params);
      await session.queue;
      this.sessions.delete(params.sessionId);
    }
    const known = await this.find(params.sessionId, session?.cwd);
    if (known) {
      await this.bo.sessions.delete(known.id).catch((err: unknown) => {
        if (!(err instanceof BoProblem && err.problem.status === 404)) throw asRequestError(err);
      });
    }
    return {};
  }

  /** Only a value the option offers: the model's engine must be the session's once it has run. */
  async setSessionConfigOption(params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
    const session = this.session(params.sessionId);
    const engines = await this.engines();
    const value = String(params.value);
    const option = configOptions(engines, session.choice, this.root).find((o) => o.id === params.configId);
    if (!option) throw acp.RequestError.invalidParams({ configId: params.configId }, `unknown config option ${params.configId}`);
    if (!optionValues(option).includes(value)) throw acp.RequestError.invalidParams({ value }, `${value} is not one of the ${option.name.toLowerCase()} options`);
    if (params.configId === "model") {
      const slash = value.indexOf("/");
      const engine = value.slice(0, slash) as EngineId;
      if (session.pinned && engine !== session.choice.engine) {
        throw acp.RequestError.invalidParams({ value }, `a session keeps its engine (${session.choice.engine}); start a new session to use ${engine}`);
      }
      const model = value.slice(slash + 1);
      session.choice = { ...session.choice, engine, model: model === "default" ? undefined : model, effort: undefined };
    } else if (params.configId === "effort") {
      session.choice = { ...session.choice, effort: value === "default" ? undefined : value };
    } else {
      this.setMode(session, value);
    }
    return { configOptions: configOptions(engines, session.choice, this.root) };
  }

  async setSessionMode(params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
    this.setMode(this.session(params.sessionId), params.modeId);
    return {};
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) return;
    session.epoch++;
    await session.active?.cancel().catch(() => undefined);
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.session(params.sessionId);
    const epoch = session.epoch;
    const turn = session.queue.then(() => (session.epoch === epoch ? this.run(session, params.prompt) : { stopReason: "cancelled" as const }));
    session.queue = turn.catch(() => undefined);
    return turn;
  }

  /** `_session/steering {sessionId, prompt}`: into the running run, else a new turn. */
  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method !== "_session/steering") throw acp.RequestError.methodNotFound(method);
    const session = this.session(String(params.sessionId));
    const prompt = (params.prompt ?? []) as acp.ContentBlock[];
    if (session.active && session.images) {
      await session.active.message(await promptParts(prompt, session.images.save));
      return { outcome: "injected" };
    }
    void this.prompt({ sessionId: session.id, prompt }).catch(() => undefined);
    return { outcome: "startedNewTurn" };
  }

  // ---- turns ----

  /** One turn; its images are removed once its run has ended. */
  private async run(session: Session, prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    const images = new Images(() => (this.imageDir ??= mkdtemp(path.join(os.tmpdir(), "bo-acp-"))));
    session.images = images;
    try {
      return await this.turn(session, await promptParts(prompt, images.save));
    } finally {
      session.images = undefined;
      await images.release();
    }
  }

  private async turn(session: Session, input: Part[]): Promise<acp.PromptResponse> {
    if (!input.length) throw acp.RequestError.invalidParams({}, "the prompt is empty");
    const mode = modes(this.root).find((m) => m.id === session.choice.mode)!;
    const spec: RunSpec = {
      ...session.meta,
      input,
      workspace: { root: session.cwd, ...(session.extraRoots.length ? { extra_roots: session.extraRoots } : {}) },
      ...(session.pinned ? {} : { engine: session.choice.engine }),
      ...(session.choice.model ? { model: session.choice.model } : {}),
      ...(session.choice.effort ? { effort: session.choice.effort } : {}),
      mcp: session.mcp,
      permissions: { access: mode.access, internet: mode.internet },
      interactive: true,
      session: session.ref,
    };
    let handle: RunHandle;
    try {
      handle = await this.bo.run(spec);
    } catch (err) {
      throw asRequestError(err);
    }
    session.active = handle;
    session.pinned = true;
    const view = new TurnView(this.conn, session.id, this.client, (itemId, response) => handle.respond(itemId, response).catch(() => undefined));
    try {
      for await (const e of handle.events()) {
        if (e.event === "delta") await view.delta(e.data.item_id, e.data.text);
        else if (e.event === "item") await view.item(e.data);
        else if (TERMINAL.has(e.data.status)) break;
      }
    } finally {
      session.active = undefined;
    }
    const run = handle.run;
    if (run.status === "cancelled") return { stopReason: "cancelled", usage: usage(run.usage) };
    if (run.status === "completed") return { stopReason: "end_turn", usage: usage(run.usage) };
    if (run.error?.code === "limit_exceeded") {
      return { stopReason: run.error.path === "/limits/max_tokens" ? "max_tokens" : "max_turn_requests", usage: usage(run.usage) };
    }
    throw new acp.RequestError(-32603, `${run.error?.message ?? "the run failed"} (${run.error?.code ?? "engine_error"})`, { run });
  }

  /** A stored run as it happened: the prompt, then its items in their final state. */
  private async replay(sessionId: string, { items }: SessionRun): Promise<void> {
    const view = new TurnView(this.conn, sessionId, this.client, async () => undefined, true);
    const [prompt, ...rest] = items;
    if (prompt?.type === "message") await this.conn.sessionUpdate({ sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: text(prompt) } } });
    for (const item of rest) await view.item(item);
  }

  // ---- sessions ----

  private open(id: string, ref: Session["ref"], params: { cwd: string; mcpServers?: acp.McpServer[] | null; additionalDirectories?: string[] | null; _meta?: Record<string, unknown> | null }, engines: readonly EngineInfo[], pinned: boolean, engine?: EngineId): Session {
    const meta = metaSpec(params._meta, params.cwd);
    const available = engines.filter((e) => e.available).map((e) => e.id);
    const chosen = engine ?? (this.defaults.engine && available.includes(this.defaults.engine) ? this.defaults.engine : available[0]);
    if (!chosen) throw new acp.RequestError(-32603, `no engine is available: ${engines.map((e) => `${e.id}: ${e.reason}`).join("; ")}`);
    const mode: ModeId = this.defaults.access === "read" ? "read" : this.defaults.access === "full" && !this.root ? "full" : "write";
    const session: Session = {
      id, ref, cwd: params.cwd, extraRoots: params.additionalDirectories ?? [], mcp: mcpServers(params.mcpServers ?? []), meta,
      choice: { engine: chosen, ...(chosen === this.defaults.engine ? { model: this.defaults.model, effort: this.defaults.effort } : {}), mode },
      pinned, queue: Promise.resolve(), epoch: 0,
    };
    this.sessions.set(id, session);
    return session;
  }

  /** resume/load: the ACP id is a key started here (`acp:…`) or a bo id (`ses_…`, e.g. from `bo run`). */
  private async reopen(params: acp.ResumeSessionRequest | acp.LoadSessionRequest): Promise<{ session: Session; engines: EngineInfo[]; known?: BoSession }> {
    const engines = await this.engines();
    const known = await this.find(params.sessionId, params.cwd);
    const ref = params.sessionId.startsWith("ses_") ? { id: params.sessionId } : { key: params.sessionId };
    const session = this.open(params.sessionId, ref, params, engines, known !== undefined, known?.engine);
    if (known?.model) session.choice = { ...session.choice, model: known.model };
    return { session, engines, known };
  }

  /** The bo session an ACP id names, in `cwd` (else anywhere); a bo id that belongs to another workspace is refused. */
  private async find(sessionId: string, cwd?: string): Promise<BoSession | undefined> {
    try {
      const found = (await this.bo.sessions.list(cwd)).find((s) => s.id === sessionId || s.key === sessionId);
      if (found || cwd === undefined || !sessionId.startsWith("ses_")) return found;
      const elsewhere = await this.bo.sessions.get(sessionId).catch(() => undefined);
      if (elsewhere) throw acp.RequestError.invalidParams({ sessionId }, `session ${sessionId} belongs to ${elsewhere.workspace}; open it there`);
      return undefined;
    } catch (err) {
      throw asRequestError(err);
    }
  }

  private session(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new acp.RequestError(-32002, `no session ${id} in this process; resume or load it first`);
    return session;
  }

  private setMode(session: Session, value: string): void {
    if (!modes(this.root).some((m) => m.id === value)) throw acp.RequestError.invalidParams({ value }, `unknown mode ${value}`);
    session.choice = { ...session.choice, mode: value as ModeId };
    void this.conn.sessionUpdate({ sessionId: session.id, update: { sessionUpdate: "current_mode_update", currentModeId: value } });
  }

  private async engines(): Promise<EngineInfo[]> {
    try {
      return await this.bo.engines();
    } catch (err) {
      throw asRequestError(err);
    }
  }

  /** Removes this process's image directory; the connection has closed. */
  async dispose(): Promise<void> {
    const dir = await this.imageDir?.catch(() => undefined);
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

/** One turn's prompt images, as files in the process's private directory (bo reads images from paths). */
class Images {
  private readonly dir: () => Promise<string>;
  private readonly files: string[] = [];

  constructor(dir: () => Promise<string>) {
    this.dir = dir;
  }

  /** Refuses an image past bo's limit before decoding it. */
  readonly save = async (data: string, mimeType: string): Promise<string> => {
    const bytes = Math.floor(data.length * 3 / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    if (bytes > MAX_IMAGE_BYTES) throw acp.RequestError.invalidParams({ mimeType, bytes }, "an image must be at most 5 MiB");
    const file = path.join(await this.dir(), `${randomUUID()}.${mimeType.split("/")[1] ?? "img"}`);
    this.files.push(file);
    await writeFile(file, Buffer.from(data, "base64"), { mode: 0o600 });
    return file;
  };

  async release(): Promise<void> {
    await Promise.all(this.files.map((f) => rm(f, { force: true })));
  }
}

/** One turn's items → `session/update`s, approvals → permission requests, questions → elicitation forms. */
class TurnView {
  private readonly conn: acp.AgentSideConnection;
  private readonly sessionId: string;
  private readonly client: acp.ClientCapabilities;
  private readonly respond: (itemId: string, response: Response) => Promise<unknown>;
  private readonly replaying: boolean;
  private readonly calls = new Set<string>();
  private readonly streamed = new Set<string>();
  private readonly parents = new Map<string, string>();
  private readonly asked = new Set<string>();
  private inputSeen = false;

  constructor(conn: acp.AgentSideConnection, sessionId: string, client: acp.ClientCapabilities, respond: TurnView["respond"], replaying = false) {
    this.conn = conn;
    this.sessionId = sessionId;
    this.client = client;
    this.respond = respond;
    this.replaying = replaying;
  }

  async delta(itemId: string, chunk: string): Promise<void> {
    if (this.parents.has(itemId)) return;
    this.streamed.add(itemId);
    await this.update({ sessionUpdate: "agent_message_chunk", messageId: itemId, content: { type: "text", text: chunk } });
  }

  async item(item: Item): Promise<void> {
    if (item.parent_id) {
      this.parents.set(item.id, item.parent_id);
      return this.child(item);
    }
    switch (item.type) {
      case "message":
        if (item.role === "user") {
          // The run's own prompt is the client's; later user messages are delivered steering.
          if (this.inputSeen || this.replaying) await this.update({ sessionUpdate: "user_message_chunk", messageId: item.id, content: { type: "text", text: text(item) } });
          this.inputSeen = true;
        } else if (item.status === "completed" && !this.streamed.has(item.id)) {
          await this.update({ sessionUpdate: "agent_message_chunk", messageId: item.id, content: { type: "text", text: text(item) } });
        }
        return;
      case "reasoning":
        return this.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: item.text } });
      case "plan":
        return this.update(planUpdate(item));
      case "action": {
        const first = !this.calls.has(item.id);
        this.calls.add(item.id);
        await this.update(toolCall(item, first));
        if (item.status === "awaiting_approval" && !this.replaying && !this.asked.has(item.id)) {
          this.asked.add(item.id);
          void this.approve(item);
        }
        return;
      }
      case "question":
        if (item.status === "awaiting_answer" && !this.replaying && !this.asked.has(item.id)) {
          this.asked.add(item.id);
          void this.ask(item);
        }
        return;
      case "notice":
        if (this.client.session?.notices) {
          await this.update({ sessionUpdate: "notice", severity: item.level, title: item.text } as acp.SessionUpdate);
        }
        return;
    }
  }

  /** A subagent's item: shown inside its delegate's tool call, never as the agent's own words. */
  private async child(item: Item): Promise<void> {
    const line = item.type === "message" && item.role === "agent" && item.status === "completed" ? text(item)
      : item.type === "action" && item.status === "running" ? `▸ ${summary(item.action)}`
        : undefined;
    if (!line) return;
    await this.update({ sessionUpdate: "tool_call_update", toolCallId: item.parent_id!, content: [{ type: "content", content: { type: "text", text: line } }] });
  }

  private async approve(item: Extract<Item, { type: "action" }>): Promise<void> {
    const { sessionUpdate: _kind, ...toolCallFields } = toolCall(item, true) as acp.ToolCall & { sessionUpdate: string };
    const answer = await this.conn.requestPermission({
      sessionId: this.sessionId, toolCall: toolCallFields, options: PERMISSION_OPTIONS.map(({ decision: _d, ...o }) => o),
    }).catch(() => ({ outcome: { outcome: "cancelled" } as const }));
    const chosen = answer.outcome.outcome === "selected" ? PERMISSION_OPTIONS.find((o) => o.optionId === (answer.outcome as { optionId: string }).optionId) : undefined;
    await this.respond(item.id, { decision: chosen?.decision ?? "deny" });
  }

  private async ask(item: Extract<Item, { type: "question" }>): Promise<void> {
    let answers: Record<string, string[]> = {};
    if (this.client.elicitation?.form) {
      const reply = await this.conn.createElicitation({ sessionId: this.sessionId, mode: "form", ...questionForm(item) }).catch(() => undefined);
      if (reply?.action === "accept") answers = answersFrom((reply as { content?: Record<string, unknown> | null }).content);
    }
    await this.respond(item.id, { answers });
  }

  private update(update: acp.SessionUpdate): Promise<void> {
    return this.conn.sessionUpdate({ sessionId: this.sessionId, update });
  }
}

/** `_meta.bo`: the RunSpec fields ACP has no word for, checked against the contract (errors under /_meta/bo). */
function metaSpec(meta: Record<string, unknown> | null | undefined, cwd: string): MetaSpec {
  const raw = meta?.bo;
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw acp.RequestError.invalidParams({ pointer: "/_meta/bo" }, "_meta.bo must be an object");
  const unknown = Object.keys(raw).filter((k) => !(META_FIELDS as readonly string[]).includes(k));
  const errors = [
    ...unknown.map((k) => ({ pointer: `/_meta/bo/${k}`, detail: "unknown field (allowed: " + META_FIELDS.join(", ") + ")" })),
    ...shapeErrors("RunSpec", { ...raw, input: [{ kind: "text", text: "x" }], workspace: { root: cwd } })
      .filter((e) => !unknown.some((k) => e.pointer === `/${k}`))
      .map((e) => ({ ...e, pointer: `/_meta/bo${e.pointer}` })),
  ];
  if (errors.length) throw acp.RequestError.invalidParams({ errors }, errors.map((e) => `${e.pointer} ${e.detail}`).join("; "));
  return raw as MetaSpec;
}

/** A bo problem or connection error as a JSON-RPC error the editor can show. */
function asRequestError(err: unknown): acp.RequestError {
  if (err instanceof acp.RequestError) return err;
  if (err instanceof BoProblem) return new acp.RequestError(-32603, `${err.problem.detail}${err.problem.errors?.length ? `: ${err.problem.errors.map((e) => `${e.pointer} ${e.detail}`).join("; ")}` : ""}`, { problem: err.problem });
  return new acp.RequestError(-32603, err instanceof Error ? err.message : String(err));
}
