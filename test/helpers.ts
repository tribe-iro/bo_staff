import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SDKMessage, SDKUserMessage, Options, Query } from "@anthropic-ai/claude-agent-sdk";
import type { Harness, Outcome, RunIO, Steer } from "../src/harness/port.ts";
import { ZERO_USAGE } from "../src/harness/port.ts";
import type { AwaitableBody, EngineId, EngineInfo, ItemBody, Part, Response } from "../src/model.ts";
import type { RunEngines } from "../src/core/runs.ts";
import type { EngineCatalog, ResolvedSpec } from "../src/spec.ts";
import { AsyncQueue } from "../src/core/queue.ts";

export function info(id: EngineId = "claude-code", over: Partial<EngineInfo> = {}): EngineInfo {
  return {
    id, available: true, version: "9.9.9", authentication: "api_key",
    models: [
      { id: "m1", aliases: ["m1-alias"], default: true, efforts: ["low", "high"], images: true },
      { id: "m2", aliases: [], default: false, efforts: [], images: false },
    ],
    ...over,
  };
}

/** The registry view a RunManager needs, over fixed harnesses. */
export function registry(...entries: { harness: Harness; info: EngineInfo }[]): RunEngines {
  const byId = new Map(entries.map((e) => [e.harness.id, e]));
  return { harness: (id) => byId.get(id)?.harness, cached: (id) => byId.get(id)?.info };
}

/** A Steer that records how the harness settled it. */
export function steer(parts: Part[]): Steer & { settled?: { delivered: true } | { dropped: string } } {
  const s: Steer & { settled?: { delivered: true } | { dropped: string } } = {
    parts,
    delivered: () => { s.settled ??= { delivered: true }; },
    dropped: (reason) => { s.settled ??= { dropped: reason }; },
  };
  return s;
}

/** A Harness whose run is a test-provided script over RunIO. */
export function scripted(id: EngineId, script: (spec: ResolvedSpec, io: RunIO) => Promise<Outcome>, over: Partial<EngineInfo> = {}): Harness {
  return { id, probe: async () => info(id, over), run: script };
}

export const ok = (text = "done"): Outcome => ({ ok: true, result: { kind: "text", text }, usage: { ...ZERO_USAGE } });

export async function tmpdir(prefix = "bo-test-"): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function skillDir(root: string, name: string): Promise<string> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\nbody\n`);
  return dir;
}

export function spec(over: Partial<ResolvedSpec> = {}): ResolvedSpec {
  return {
    runId: "run_test", engine: "claude-code", input: [{ kind: "text", text: "hi" }], root: "/tmp", extraRoots: [],
    skills: [], mcp: {}, subagents: {}, access: "write", internet: false, interactive: false, images: true, env: {}, limits: {},
    timeoutMs: 60_000, ...over,
  };
}

/** A recording RunIO for adapter-level tests. */
export function stubIo(opts: { respond?: (body: AwaitableBody) => Response | undefined; tmpDir?: string } = {}) {
  const upserts: { key: string; body: ItemBody; parentKey?: string }[] = [];
  const awaited: { key: string; body: AwaitableBody }[] = [];
  const messages = new AsyncQueue<Steer>();
  const ac = new AbortController();
  const allowedForRun = new Set<string>();
  const state = { session: "", model: "", accepting: false };
  const calls: { tokens: number; main: boolean }[] = [];
  const io: RunIO = {
    signal: ac.signal, tmpDir: opts.tmpDir ?? os.tmpdir(), allowedForRun, messages,
    session: (n) => { state.session = n; },
    model: (m) => { state.model = m; },
    upsert: (key, body, parentKey) => { upserts.push({ key, body, parentKey }); },
    delta: () => {},
    await: async (key, body) => { awaited.push({ key, body }); return opts.respond?.(body); },
    accept: (on) => { state.accepting = on; },
    modelCall: (tokens, main) => { calls.push({ tokens, main }); },
  };
  return { io, upserts, awaited, messages, ac, allowedForRun, state, calls };
}

/** Fake `query()` for the Claude adapter: yields scripted messages and drives canUseTool at scripted points. */
export function fakeQuery(script: {
  messages: SDKMessage[];
  permissions?: { afterMessage: number; toolName: string; input: Record<string, unknown>; toolUseID: string; decisionReason?: string }[];
  account?: Record<string, unknown>;
  waitForPrompt?: boolean;
}) {
  const calls: { options?: Options; permissionResults: unknown[]; prompts: SDKUserMessage[] } = { permissionResults: [], prompts: [] };
  const fn = ((params: { prompt: AsyncIterable<SDKUserMessage> | string; options?: Options }) => {
    calls.options = params.options;
    let interrupted = false;
    const promptIt = typeof params.prompt === "string" ? undefined : params.prompt[Symbol.asyncIterator]();
    const gen = (async function* () {
      if (promptIt) {
        const first = await promptIt.next();
        if (first.done) return;
        calls.prompts.push(first.value);
        void (async () => { for (;;) { const n = await promptIt.next(); if (n.done) break; calls.prompts.push(n.value); } })();
      }
      for (const [i, m] of script.messages.entries()) {
        for (const p of script.permissions?.filter((x) => x.afterMessage === i) ?? []) {
          const r = await params.options!.canUseTool!(p.toolName, p.input, {
            signal: new AbortController().signal, toolUseID: p.toolUseID, requestId: "r", decisionReason: p.decisionReason,
          } as never);
          calls.permissionResults.push(r);
        }
        if (interrupted) return;
        const msg = m.type === "result" && calls.prompts[0]?.uuid ? { ...m, user_message_uuids: calls.prompts.map((u) => u.uuid!) } : m;
        yield msg as SDKMessage;
      }
    })();
    return Object.assign(gen, {
      accountInfo: async () => script.account ?? { apiKeySource: "ANTHROPIC_API_KEY" },
      supportedModels: async () => [
        { value: "default", resolvedModel: "claude-x-1", displayName: "Default", description: "", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
        { value: "opus", resolvedModel: "claude-x-1", displayName: "Opus", description: "", supportsEffort: true, supportedEffortLevels: ["high", "max"] },
        { value: "haiku", resolvedModel: "claude-h-1", displayName: "Haiku", description: "", supportsEffort: false },
      ],
      interrupt: async () => { interrupted = true; return undefined; },
      close: () => {},
    }) as unknown as Query;
  }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
  return { fn, calls };
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fixed catalog (tests, conformance): no probing. */
export function fixedCatalog(infos: readonly EngineInfo[], defaultEngine?: EngineId): EngineCatalog {
  const byId = new Map(infos.map((info) => [info.id, info]));
  return {
    info: async (id) => byId.get(id),
    defaultEngine: async () => defaultEngine,
  };
}
