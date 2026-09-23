import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encodeSession, mint } from "../ids.ts";
import type {
  AwaitableBody, EngineId, EngineInfo, Item, ItemBody, Part, Response, Run, StreamEvent,
} from "../model.ts";
import { problem, type Problem } from "../problems.ts";
import { ruleKey, ZERO_USAGE, type Harness, type Outcome, type RunIO, type Steer } from "../harness/port.ts";
import type { ResolvedSpec } from "../spec.ts";
import { AsyncQueue } from "./queue.ts";
import { SessionIndex } from "./sessions.ts";
import { describe, silent, type Logger } from "../log.ts";
import { count, duration, summary } from "../format.ts";

export const AWAIT_EXPIRY_MS = 15 * 60_000;
export const RETAIN_MS = 10 * 60_000;
const RETAIN_MAX = 256;
const RETAIN_BYTES = 256 * 1024 * 1024;
const IDEMPOTENCY_MS = 10 * 60_000;
const IDEMPOTENCY_MAX = 4_096;
const MAX_ITEMS = 10_000;
const MAX_EVENTS = 20_000;
const MAX_BYTES = 32 * 1024 * 1024;
const TERMINAL_RESERVE_BYTES = 4_096;
const MAX_SUBSCRIBERS = 32;
const SUBSCRIBER_EVENTS = 1_024;
const MAX_STEERING = 64;
const STOP_GRACE_MS = 5_000;

type Logged = Extract<StreamEvent, { id: number }>;
type StopReason = "cancelled" | "timeout" | "resource_exhausted" | "limit_exceeded";

/** What the run manager needs from the engine registry. */
export interface RunEngines {
  harness(id: EngineId): Harness | undefined;
  cached(id: EngineId): EngineInfo | undefined;
}

/** A live view of one run's event log. `close()` releases it immediately, even while a `next()` is pending. */
export interface Subscription {
  run: Run;
  seq: number;
  events: AsyncIterable<StreamEvent>;
  close(): void;
}

interface Awaiting {
  key: string;
  body: AwaitableBody;
  parentKey?: string;
  resolve: (r: Response | undefined) => void;
  timer: NodeJS.Timeout;
}

interface RunRecord {
  run: Run;
  spec: ResolvedSpec;
  seq: number;
  log: Logged[];
  logBytes: number;
  subscribers: Set<AsyncQueue<StreamEvent>>;
  items: Map<string, Item>;
  keys: Map<string, string>;
  awaiting: Map<string, Awaiting>;
  messages: AsyncQueue<Steer>;
  /** Steers not yet delivered or dropped; whatever is left when the run finishes is dropped. */
  unsettled: Set<Steer>;
  steers: number;
  /** Model calls in the agent's own loop, and tokens across every call, for `limits`. */
  turns: number;
  tokens: number;
  /** Which limit stopped the run. */
  limit?: string;
  accepting: boolean;
  ac: AbortController;
  stop: PromiseWithResolvers<StopReason>;
  reason?: StopReason;
  tmpDir: string;
  allowedForRun: Set<string>;
  sessionKey?: string;
  idempotencyKey?: string;
  /** The A2A context the run belongs to, recorded with its session. */
  context?: string;
  finished: boolean;
  done: Promise<void>;
}

interface IdempotencyRecord {
  requestHash: string;
  runId: string;
  snapshot: Run;
  expiresAt: number;
}

export type Created = { run: Run; replayed: boolean } | { problem: Problem };

export class RunManager {
  private readonly records = new Map<string, RunRecord>();
  /** Finished run ids, oldest first. */
  private readonly finishedOrder = new Set<string>();
  private retainedBytes = 0;
  private readonly sessionActive = new Map<string, string>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly engines: RunEngines;
  private readonly maxRuns: number;
  private readonly retainBytes: number;
  private readonly log: Logger;
  private readonly logSteps: boolean;
  readonly sessions: SessionIndex;

  constructor(opts: { engines: RunEngines; maxRuns: number; sessions: SessionIndex; retainBytes?: number; log?: Logger; logSteps?: boolean }) {
    this.logSteps = opts.logSteps ?? false;
    this.engines = opts.engines;
    this.maxRuns = opts.maxRuns;
    this.sessions = opts.sessions;
    this.retainBytes = opts.retainBytes ?? RETAIN_BYTES;
    this.log = opts.log ?? silent;
  }

  /** The run an idempotency key already produced, if any. */
  replay(key: string, hash: string): Created | undefined {
    this.expireIdempotency();
    const hit = this.idempotency.get(key);
    if (!hit) return undefined;
    if (hit.requestHash !== hash) return { problem: problem("idempotency_mismatch", "Idempotency-Key was used with a different spec") };
    return { run: structuredClone(hit.snapshot), replayed: true };
  }

  async create(spec: ResolvedSpec, opts: { idempotency?: { key: string; hash: string }; context?: string } = {}): Promise<Created> {
    const idem = opts.idempotency;
    if (idem) {
      const replayed = this.replay(idem.key, idem.hash);
      if (replayed) return replayed;
      if (this.idempotency.size >= IDEMPOTENCY_MAX) {
        return { problem: problem("too_many_idempotency_keys", "idempotency capacity is exhausted; retry after existing keys expire") };
      }
    }
    let active = 0;
    for (const record of this.records.values()) if (!record.finished) active++;
    if (active >= this.maxRuns) return { problem: problem("too_many_runs", `at most ${this.maxRuns} runs may be active`) };

    const sessionKey = spec.session && !spec.session.fork ? `${spec.engine}:${spec.session.native}` : undefined;
    if (sessionKey && this.sessionActive.has(sessionKey)) return { problem: problem("session_busy", "the session already has an active run") };
    const harness = this.engines.harness(spec.engine);
    const info = this.engines.cached(spec.engine);
    if (!harness || !info) return { problem: problem("engine_unavailable", `${spec.engine} is not configured`) };

    // Everything up to `records.set` is synchronous: admission cannot race.
    const run: Run = {
      id: spec.runId,
      session_id: spec.session && !spec.session.fork ? encodeSession(spec.engine, spec.session.native) : null,
      status: "running",
      engine: { id: spec.engine, version: info.version ?? "unknown" },
      model: null,
      created_at: new Date().toISOString(),
      usage: { ...ZERO_USAGE },
    };
    const record: RunRecord = {
      run, spec, seq: 0, log: [], logBytes: 0, subscribers: new Set(), items: new Map(), keys: new Map(), awaiting: new Map(),
      messages: new AsyncQueue(MAX_STEERING), unsettled: new Set(), steers: 0, turns: 0, tokens: 0, accepting: false,
      ac: new AbortController(), stop: Promise.withResolvers<StopReason>(),
      tmpDir: "", allowedForRun: new Set(), sessionKey, idempotencyKey: idem?.key, context: opts.context, finished: false, done: Promise.resolve(),
    };
    if (sessionKey) this.sessionActive.set(sessionKey, run.id);
    if (idem) this.idempotency.set(idem.key, {
      requestHash: idem.hash, runId: run.id, snapshot: structuredClone(run), expiresAt: Date.now() + IDEMPOTENCY_MS,
    });
    this.records.set(run.id, record);
    this.log(`${run.id}  started    ${spec.engine} · ${spec.access} · ${spec.root}${spec.session ? ` · ${spec.session.fork ? "fork of" : "resuming"} ${encodeSession(spec.engine, spec.session.native)}` : ""}`);
    this.emitRun(record);
    this.upsert(record, "input", { type: "message", role: "user", content: spec.input, status: "completed" });

    try {
      record.tmpDir = await mkdtemp(path.join(os.tmpdir(), `bo-${run.id}-`));
    } catch (error) {
      record.done = this.finish(record, {
        ok: false, error: { code: "engine_error", message: "failed to prepare run workspace" }, usage: run.usage, diagnostic: error,
      });
      return { run: structuredClone(run), replayed: false };
    }

    const timeout = setTimeout(() => this.requestStop(record, "timeout"), spec.timeoutMs);
    const harnessOutcome = new Promise<Outcome>((resolve) => setImmediate(() => {
      if (record.ac.signal.aborted) {
        resolve({ ok: false, error: { code: "engine_error", message: "run stopped before engine start" }, usage: run.usage });
        return;
      }
      harness.run(spec, this.io(record)).then(resolve, (error: unknown) => resolve({
        ok: false, error: { code: "engine_error", message: "engine execution failed" }, usage: run.usage, diagnostic: error,
      }));
    }));
    record.done = (async () => {
      const outcome = await Promise.race([
        harnessOutcome,
        record.stop.promise.then(() => Promise.race([
          harnessOutcome,
          delay(STOP_GRACE_MS).then((): Outcome => ({
            ok: false, error: { code: "engine_error", message: "engine did not terminate" }, usage: run.usage,
          })),
        ])),
      ]);
      clearTimeout(timeout);
      await this.finish(record, outcome);
    })();
    return { run: structuredClone(run), replayed: false };
  }

  get(id: string): Run | undefined {
    const record = this.records.get(id);
    return record && structuredClone(record.run);
  }

  list(): Run[] {
    return [...this.records.values()]
      .sort((a, b) => Number(a.finished) - Number(b.finished) || b.run.created_at.localeCompare(a.run.created_at) || b.run.id.localeCompare(a.run.id))
      .map(({ run }) => structuredClone(run));
  }

  /** Items currently awaiting a response. */
  pending(id: string): Item[] {
    const record = this.records.get(id);
    return record ? [...record.awaiting.keys()].map((itemId) => structuredClone(record.items.get(itemId)!)) : [];
  }

  observe(id: string, afterSeq?: number): Subscription | Problem {
    const record = this.records.get(id);
    if (!record) return notFound(id);
    if (!record.finished && record.subscribers.size >= MAX_SUBSCRIBERS) {
      return problem("too_many_subscribers", `run ${id} has too many subscribers`);
    }
    const seq = record.seq;
    const queue = new AsyncQueue<StreamEvent>(SUBSCRIBER_EVENTS);
    const after = afterSeq ?? seq;
    for (let i = firstAfter(record.log, after); i < record.log.length; i++) if (!queue.push(record.log[i]!)) break;
    if (record.finished || queue.size >= SUBSCRIBER_EVENTS) queue.close();
    else record.subscribers.add(queue);
    const close = (): void => {
      record.subscribers.delete(queue);
      queue.close();
    };
    const events: AsyncIterable<StreamEvent> = {
      [Symbol.asyncIterator]: () => ({
        next: () => queue.next(),
        return: async () => { close(); return { value: undefined, done: true }; },
      }),
    };
    return { run: structuredClone(record.run), seq, events, close };
  }

  message(id: string, content: Part[]): Problem | undefined {
    const record = this.records.get(id);
    if (!record) return notFound(id);
    if (!record.spec.images && content.some((part) => part.kind === "image")) {
      return problem("unsupported_feature", `${record.run.model ?? record.spec.model ?? "this model"} does not accept images`);
    }
    if (record.finished || !record.accepting || record.ac.signal.aborted) {
      return problem("not_accepting_messages", `run ${id} is not accepting messages now`);
    }
    const steer = this.steer(record, content);
    if (!record.messages.push(steer)) {
      record.unsettled.delete(steer);
      return problem("too_many_messages", `run ${id} has too many queued messages`);
    }
    return undefined;
  }

  respond(id: string, itemId: string, response: Response): Problem | undefined {
    const record = this.records.get(id);
    if (!record) return notFound(id);
    if (!record.items.has(itemId)) return problem("item_not_found", `no item ${itemId} in run ${id}`);
    const pending = record.awaiting.get(itemId);
    if (!pending) return problem("item_not_awaiting", `item ${itemId} is not awaiting a response`);
    const decision = "decision" in response;
    if (decision !== (pending.body.type === "action")) {
      return problem("wrong_response_kind", `item ${itemId} expects ${pending.body.type === "action" ? "a decision" : "answers"}`);
    }
    if (pending.body.type === "action" && decision && response.decision === "allow_for_run") record.allowedForRun.add(ruleKey(pending.body.action));
    this.resolveAwaiting(record, itemId, response, resolvedBody(pending.body, response));
    return undefined;
  }

  cancel(id: string): Problem | undefined {
    const record = this.records.get(id);
    if (!record) return notFound(id);
    if (!record.finished) this.requestStop(record, "cancelled");
    return undefined;
  }

  async shutdown(): Promise<void> {
    const active = [...this.records.values()].filter((record) => !record.finished);
    for (const record of active) this.requestStop(record, "cancelled");
    await Promise.allSettled(active.map(({ done }) => done));
  }

  private steer(record: RunRecord, parts: Part[]): Steer {
    const n = ++record.steers;
    let settled = false;
    const settle = (publish: () => void): void => {
      if (settled) return;
      settled = true;
      record.unsettled.delete(steer);
      if (!record.finished) publish();
    };
    const steer: Steer = {
      parts,
      delivered: () => settle(() => this.upsert(record, `message:${n}`, { type: "message", role: "user", content: parts, status: "completed" })),
      dropped: (reason) => settle(() => this.upsert(record, `notice:steer:${n}`, {
        type: "notice", level: "warning", text: `steering message not delivered: ${reason}`,
      })),
    };
    record.unsettled.add(steer);
    return steer;
  }

  /** `bo serve -v`: one line per action start, failure, denial, and per notice, like `bo run -v`. */
  private logStep(record: RunRecord, body: ItemBody, previous: Item | undefined): void {
    const id = record.run.id;
    if (body.type === "notice") this.log(`${id}  ! ${body.text}`);
    else if (body.type !== "action") return;
    else if (body.status === "failed") this.log(`${id}  ✗ ${summary(body.action)}${body.outcome?.exit_code !== undefined ? ` · exit ${body.outcome.exit_code}` : ""}`);
    else if (body.status === "denied") this.log(`${id}  ⊘ ${summary(body.action)} · ${body.reason ?? "denied"}`);
    else if (!previous) this.log(`${id}  ▸ ${summary(body.action)}`);
  }

  private noteSession(record: RunRecord, ended: boolean): void {
    const { run, spec } = record;
    if (!run.session_id) return;
    this.sessions.note({
      id: run.session_id, engine: spec.engine, workspace: spec.root, input: spec.input, model: run.model, context: record.context, ended,
    });
  }

  private requestStop(record: RunRecord, reason: StopReason): void {
    if (record.finished || record.reason) return;
    record.reason = reason;
    record.accepting = false;
    record.messages.close();
    this.closeAwaiting(record, "run ended");
    record.ac.abort(reason);
    record.stop.resolve(reason);
  }

  private io(record: RunRecord): RunIO {
    return {
      signal: record.ac.signal,
      get tmpDir() { return record.tmpDir; },
      allowedForRun: record.allowedForRun,
      messages: record.messages,
      session: (native) => {
        if (record.finished) return;
        const key = `${record.spec.engine}:${native}`;
        if (record.sessionKey !== key) {
          if (record.sessionKey && this.sessionActive.get(record.sessionKey) === record.run.id) this.sessionActive.delete(record.sessionKey);
          record.sessionKey = key;
          this.sessionActive.set(key, record.run.id);
        }
        const id = encodeSession(record.spec.engine, native);
        if (record.run.session_id !== id) {
          record.run.session_id = id;
          this.noteSession(record, false);
          this.emitRun(record);
        }
      },
      model: (id) => {
        if (!record.finished && record.run.model !== id) { record.run.model = id; this.emitRun(record); }
      },
      upsert: (key, body, parentKey) => {
        if (record.finished) return;
        const itemId = record.keys.get(key);
        if (!itemId || !record.awaiting.has(itemId)) this.upsert(record, key, body, parentKey);
      },
      delta: (key, text) => {
        const itemId = record.keys.get(key);
        if (!record.finished && itemId && text) this.broadcast(record, { event: "delta", data: { item_id: itemId, text } });
      },
      await: (key, body, parentKey) => {
        if (record.finished || record.ac.signal.aborted) return Promise.resolve(undefined);
        const itemId = this.upsert(record, key, body, parentKey);
        if (!itemId) return Promise.resolve(undefined);
        return new Promise<Response | undefined>((resolve) => {
          const timer = setTimeout(() => this.resolveAwaiting(record, itemId, undefined, closedBody(body, "expired")), AWAIT_EXPIRY_MS);
          timer.unref();
          record.awaiting.set(itemId, { key, body, parentKey, resolve, timer });
          this.refreshStatus(record);
        });
      },
      accept: (on) => { record.accepting = on && !record.finished && !record.ac.signal.aborted; },
      modelCall: (tokens, main) => {
        if (record.finished) return;
        if (main) record.turns++;
        record.tokens += tokens;
        // Enforced here for every engine alike: the run stops at the first model call past a limit.
        const { maxTurns, maxTokens } = record.spec.limits;
        if (maxTurns !== undefined && record.turns > maxTurns) record.limit = `the run went past max_turns (${maxTurns})`;
        else if (maxTokens !== undefined && record.tokens > maxTokens) record.limit = `the run went past max_tokens (${maxTokens})`;
        if (record.limit) this.requestStop(record, "limit_exceeded");
      },
    };
  }

  private upsert(record: RunRecord, key: string, body: ItemBody, parentKey?: string): string | undefined {
    let itemId = record.keys.get(key);
    const previous = itemId ? record.items.get(itemId) : undefined;
    if (!itemId) {
      if (record.items.size >= MAX_ITEMS) { this.requestStop(record, "resource_exhausted"); return undefined; }
      itemId = mint("itm");
      record.keys.set(key, itemId);
    }
    const parentId = parentKey === undefined ? previous?.parent_id : record.keys.get(parentKey);
    const logged = this.emit(record, {
      event: "item", id: 0,
      data: { ...body, id: itemId, ...(parentId ? { parent_id: parentId } : {}), created_at: previous?.created_at ?? new Date().toISOString() } as Item,
    });
    if (!logged) return undefined;
    if (this.logSteps) this.logStep(record, body, previous);
    // The logged copy is immutable once emitted, so the item table shares it instead of cloning again.
    record.items.set(itemId, logged.data as Item);
    return itemId;
  }

  private resolveAwaiting(record: RunRecord, itemId: string, response: Response | undefined, body: ItemBody | undefined): void {
    const pending = record.awaiting.get(itemId);
    if (!pending) return;
    clearTimeout(pending.timer);
    record.awaiting.delete(itemId);
    if (body) this.upsert(record, pending.key, body, pending.parentKey);
    this.refreshStatus(record);
    pending.resolve(response);
  }

  /** Settles every awaiting item with a terminal body; the engine gets no response. */
  private closeAwaiting(record: RunRecord, reason: string): void {
    for (const [itemId, pending] of [...record.awaiting]) this.resolveAwaiting(record, itemId, undefined, closedBody(pending.body, reason));
  }

  private refreshStatus(record: RunRecord): void {
    if (record.finished || record.reason) return;
    const status = record.awaiting.size ? "waiting" : "running";
    if (record.run.status !== status) { record.run.status = status; this.emitRun(record); }
  }

  private emitRun(record: RunRecord, terminal = false): void {
    const logged = this.emit(record, { event: "run", id: 0, data: record.run }, terminal);
    if (logged && record.idempotencyKey) {
      const idem = this.idempotency.get(record.idempotencyKey);
      if (idem?.runId === record.run.id) idem.snapshot = logged.data as Run;
    }
  }

  /** Appends a frozen copy to the log and fans it out; `undefined` when a resource limit refused it. */
  private emit(record: RunRecord, event: Logged, terminal = false): Logged | undefined {
    const frozen = { ...event, id: record.seq + 1, data: structuredClone(event.data) } as Logged;
    const bytes = Buffer.byteLength(JSON.stringify(frozen));
    const eventLimit = terminal ? MAX_EVENTS : MAX_EVENTS - 1;
    const byteLimit = terminal ? MAX_BYTES : MAX_BYTES - TERMINAL_RESERVE_BYTES;
    if (record.log.length >= eventLimit || record.logBytes + bytes > byteLimit) {
      if (!terminal) this.requestStop(record, "resource_exhausted");
      return undefined;
    }
    record.seq++;
    record.log.push(frozen);
    record.logBytes += bytes;
    this.broadcast(record, frozen);
    return frozen;
  }

  private broadcast(record: RunRecord, event: StreamEvent): void {
    for (const queue of record.subscribers) {
      if (!queue.push(event)) {
        queue.close();
        record.subscribers.delete(queue);
      }
    }
  }

  private async finish(record: RunRecord, outcome: Outcome): Promise<void> {
    if (record.finished) return;
    let final = outcome;
    if (outcome.ok && record.spec.validateOutput) {
      const value = outcome.result.kind === "data" ? outcome.result.data : undefined;
      if (!record.spec.validateOutput(value)) {
        const first = record.spec.validateOutput.errors?.[0];
        final = {
          ok: false,
          error: { code: "invalid_output", message: "structured output does not match the requested schema", ...(first?.instancePath ? { path: first.instancePath } : {}) },
          usage: outcome.usage,
          diagnostic: record.spec.validateOutput.errors,
        };
      }
    }
    const run = record.run;
    if (record.reason === "cancelled") run.status = "cancelled";
    else if (record.reason === "timeout") {
      run.status = "failed";
      run.error = { code: "timeout", message: `timed out after ${record.spec.timeoutMs / 1000}s` };
    } else if (record.reason === "limit_exceeded") {
      run.status = "failed";
      run.error = { code: "limit_exceeded", message: record.limit ?? "the run went past a limit" };
    } else if (record.reason === "resource_exhausted") {
      run.status = "failed";
      run.error = { code: "resource_exhausted", message: "run exceeded a resource limit" };
    } else if (final.ok) {
      run.status = "completed";
      run.result = final.result;
    } else {
      run.status = "failed";
      run.error = final.error;
    }
    run.usage = final.usage;
    run.ended_at = new Date().toISOString();
    const u = run.usage;
    const facts = [
      duration(Date.parse(run.ended_at) - Date.parse(run.created_at)), run.model,
      u.input_tokens || u.output_tokens ? `${count(u.input_tokens)} in · ${count(u.output_tokens)} out` : undefined,
      u.cost_usd === undefined ? undefined : `$${u.cost_usd.toFixed(4)}`,
    ].filter(Boolean).join(" · ");
    if (run.error) this.log(`${run.id}  failed     ${run.error.code}: ${run.error.message} · ${facts}`, describe(final.diagnostic));
    else this.log(`${run.id}  ${run.status.padEnd(9)}  ${facts}`);
    this.closeAwaiting(record, "run ended");
    record.accepting = false;
    record.messages.close();
    for (const steer of [...record.unsettled]) steer.dropped("run ended");
    record.finished = true;
    this.emitRun(record, true);
    this.noteSession(record, true);
    for (const queue of record.subscribers) queue.close();
    record.subscribers.clear();
    if (record.sessionKey && this.sessionActive.get(record.sessionKey) === run.id) this.sessionActive.delete(record.sessionKey);
    if (record.tmpDir) await rm(record.tmpDir, { recursive: true, force: true }).catch(() => undefined);
    this.retain(record);
  }

  private expireIdempotency(): void {
    const now = Date.now();
    // Insertion order is expiry order (fixed TTL), so stop at the first live key.
    for (const [key, value] of this.idempotency) {
      if (value.expiresAt > now) break;
      this.idempotency.delete(key);
    }
  }

  private retain(record: RunRecord): void {
    this.finishedOrder.add(record.run.id);
    this.retainedBytes += record.logBytes;
    setTimeout(() => this.forget(record.run.id), RETAIN_MS).unref();
    for (const oldest of this.finishedOrder) {
      if (this.finishedOrder.size <= RETAIN_MAX && this.retainedBytes <= this.retainBytes) break;
      this.forget(oldest);
    }
  }

  private forget(id: string): void {
    if (!this.finishedOrder.delete(id)) return;
    const record = this.records.get(id);
    if (record) this.retainedBytes -= record.logBytes;
    this.records.delete(id);
  }
}

function notFound(id: string): Problem {
  return problem("run_not_found", `no run ${id}`);
}

/** Index of the first logged event with `id > after` (ids are contiguous from 1, so this is O(1)). */
function firstAfter(log: readonly Logged[], after: number): number {
  return Math.min(Math.max(0, Math.floor(after)), log.length);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolvedBody(body: AwaitableBody, response: Response): ItemBody {
  if (body.type === "question") return { ...body, status: "answered", answers: "answers" in response ? response.answers : {} };
  return { ...body, status: "decision" in response && response.decision !== "deny" ? "running" : "denied" };
}

/** The terminal body of an item that got no response: a question expires, an action is denied for `reason`. */
function closedBody(body: AwaitableBody, reason: string): ItemBody {
  return body.type === "question" ? { ...body, status: "expired" } : { ...body, status: "denied", reason };
}
