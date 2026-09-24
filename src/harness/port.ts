// The south port. Everything a harness adapter may know about bo, and nothing more.

import type {
  Action, AwaitableBody, EngineId, EngineInfo, ErrorCode, ItemBody, Part, Response, ResultPart, Usage,
} from "../model.ts";
import type { ResolvedSpec } from "../spec.ts";

export interface Harness {
  readonly id: EngineId;
  probe(): Promise<EngineInfo>;
  run(spec: ResolvedSpec, io: RunIO): Promise<Outcome>;
}

/** Receives every raw native message a harness sees (conformance recording only). */
export type NativeTap = (entry: unknown) => void;

/**
 * `usage` is this run's. `totals` is the engine's own running total for the session after the run, when the engine keeps
 * one (the next run's baseline, `ResolvedSpec.session.totals`).
 */
export type Outcome = (
  | { ok: true; result: ResultPart }
  | { ok: false; error: { code: ErrorCode; message: string; path?: string } }
) & { usage: Usage; totals?: Usage; diagnostic?: unknown };

/** A caller message queued for the engine. The harness settles it exactly once. */
export interface Steer {
  readonly parts: Part[];
  /** The engine accepted the message; it now appears as a user message item. */
  delivered(): void;
  /** The engine never received the message; a warning notice says why. */
  dropped(reason: string): void;
}

export interface RunIO {
  readonly signal: AbortSignal;
  readonly tmpDir: string;
  readonly allowedForRun: ReadonlySet<string>;
  session(native: string): void;
  model(id: string): void;
  upsert(key: string, body: ItemBody, parentKey?: string): void;
  delta(key: string, text: string): void;
  /** Publishes an awaiting item; resolves with the caller's response, or undefined on expiry/abort. */
  await(key: string, body: AwaitableBody, parentKey?: string): Promise<Response | undefined>;
  readonly messages: AsyncIterable<Steer>;
  accept(on: boolean): void;
  /** A model call finished: its tokens (input, cached included, plus output); `main` for the agent's own loop. */
  modelCall(tokens: number, main: boolean): void;
}

/** Output of the pure translators: a declarative description of what to do with RunIO. */
export type Op =
  | { op: "upsert"; key: string; body: ItemBody; parentKey?: string }
  | { op: "delta"; key: string; text: string }
  | { op: "session"; native: string }
  | { op: "model"; id: string }
  | { op: "call"; tokens: number; main: boolean };

export function applyOps(io: RunIO, ops: readonly Op[]): void {
  for (const o of ops) {
    switch (o.op) {
      case "upsert": io.upsert(o.key, o.body, o.parentKey); break;
      case "delta": io.delta(o.key, o.text); break;
      case "session": io.session(o.native); break;
      case "model": io.model(o.id); break;
      case "call": io.modelCall(o.tokens, o.main); break;
    }
  }
}

export const ZERO_USAGE: Usage = Object.freeze({ input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  const cost = a.cost_usd === undefined && b.cost_usd === undefined ? undefined : (a.cost_usd ?? 0) + (b.cost_usd ?? 0);
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cached_input_tokens: a.cached_input_tokens + b.cached_input_tokens,
    ...(cost === undefined ? {} : { cost_usd: cost }),
  };
}

/**
 * This run's share of an engine's running totals. A baseline above the totals in any field means the engine started
 * its totals over, so the totals are all this run's.
 */
export function usageSince(totals: Usage, baseline: Usage | undefined): Usage {
  if (!baseline) return totals;
  const restarted = totals.input_tokens < baseline.input_tokens || totals.output_tokens < baseline.output_tokens
    || totals.cached_input_tokens < baseline.cached_input_tokens || (totals.cost_usd ?? 0) < (baseline.cost_usd ?? 0);
  if (restarted) return totals;
  return {
    input_tokens: totals.input_tokens - baseline.input_tokens,
    output_tokens: totals.output_tokens - baseline.output_tokens,
    cached_input_tokens: totals.cached_input_tokens - baseline.cached_input_tokens,
    ...(totals.cost_usd === undefined ? {} : { cost_usd: totals.cost_usd - (baseline.cost_usd ?? 0) }),
  };
}

export function failure(code: ErrorCode, message: string, usage: Usage = ZERO_USAGE, diagnostic?: unknown): Outcome {
  return { ok: false, error: { code, message }, usage, ...(diagnostic === undefined ? {} : { diagnostic }) };
}

/** Key under which `allow_for_run` is remembered (see `Decision`). */
export function ruleKey(a: Action): string {
  if (a.kind === "mcp") return `mcp:${a.server}/${a.tool}`;
  if (a.kind === "other") return `other:${a.name}`;
  return a.kind;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
