// Shared scaffolding for the live integration suite: a real `bo` server subprocess driving the real `claude` and
// `codex` CLIs (real models, real sandboxes). Nothing here is faked.
//
//   BO_ALLOW_SUBSCRIPTION_AUTH=1 npm run test:integration      # both engines
//   BO_IT_ENGINE=codex npm run test:integration                 # one engine
//
// An engine that is not available on this machine is skipped with its reason; if none is available the suite fails.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Bo, type RunHandle } from "../../src/client.ts";
import { ENGINE_IDS, type EngineId, type EngineInfo, type Item, type Run, type RunSpec, type StreamEvent } from "../../src/model.ts";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const FIXTURES = path.join(ROOT, "test", "fixtures");
export const FAKE_MCP = path.join(ROOT, "test", "fake", "mcp-server.mjs");
export const RED_PNG = path.join(FIXTURES, "red.png");
export const MARKER_SKILL = path.join(FIXTURES, "skills", "marker");

/** Per-test budget for one live model run (plus slack for approvals and tool calls). */
export const LIVE_TIMEOUT = 6 * 60_000;

export interface BoProcess {
  url: string;
  /** The server's XDG state (and config) home. */
  stateHome: string;
  child: ChildProcess;
  stderr: () => string;
  bo: Bo;
  stop(signal?: NodeJS.Signals): Promise<number | null>;
}

/** Starts `bo serve` on an ephemeral port and waits for its listening line. */
export async function startBo(env: Record<string, string> = {}): Promise<BoProcess> {
  const stateHome = await mkdtemp(path.join(os.tmpdir(), "bo-it-state-"));
  const child = spawn(process.execPath, [path.join(ROOT, "bin", "bo.mjs"), "serve", "--port", "0"], {
    cwd: ROOT,
    // Own state and config directories: the session index and Codex home of a test server never touch the operator's.
    env: {
      ...process.env, BO_ALLOW_SUBSCRIPTION_AUTH: process.env.BO_ALLOW_SUBSCRIPTION_AUTH ?? "1", PORT: "0",
      XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: stateHome, ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bo did not start:\n${log}`)), 60_000);
    child.stderr!.on("data", (c: Buffer) => {
      log += c.toString();
      const m = /listening on (http:\/\/\S+)/.exec(log);
      if (m) { clearTimeout(timer); resolve(m[1]!); }
    });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`bo exited with ${code}:\n${log}`)); });
  });
  return {
    url, stateHome, child, stderr: () => log, bo: new Bo({ url }),
    stop: (signal = "SIGTERM") => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(child.exitCode);
      child.once("exit", (code) => resolve(code));
      child.kill(signal);
    }),
  };
}

/** Which engines to exercise, and which of them this machine can actually run. */
export async function enginesUnderTest(bo: Bo): Promise<{ id: EngineId; info?: EngineInfo; skip: string | false }[]> {
  const wanted = (process.env.BO_IT_ENGINE?.split(",") ?? ENGINE_IDS) as EngineId[];
  const infos = await bo.engines();
  const out = wanted.map((id) => {
    const info = infos.find((h) => h.id === id);
    return { id, info, skip: info?.available ? (false as const) : `${id} unavailable: ${info?.reason ?? "not configured"}` };
  });
  if (out.every((engine) => engine.skip)) throw new Error(`no engine available: ${out.map((engine) => engine.skip).join("; ")}`);
  return out;
}

/** A fresh git workspace at `<fresh parent>/repo` (so `..` is untouched by any other test). */
export async function workspace(files: Record<string, string> = {}): Promise<string> {
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), "bo-it-")), "repo");
  await mkdir(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

export interface Finished {
  run: Run;
  items: Item[];
  events: StreamEvent[];
  handle: RunHandle;
}

/**
 * Creates a run and drains its SSE stream to the terminal state. `onItem` may respond or steer; `onStart` fires once
 * the stream is attached (use it to schedule cancels or messages).
 */
export async function runToEnd(bo: Bo, spec: RunSpec, hooks: {
  onItem?: (item: Item, handle: RunHandle) => void | Promise<void>;
  onStart?: (handle: RunHandle) => void;
} = {}): Promise<Finished> {
  const handle = await bo.run(spec);
  const events: StreamEvent[] = [];
  const items = new Map<string, Item>();
  let started = false;
  for await (const e of handle.events()) {
    events.push(e);
    if (!started) { started = true; hooks.onStart?.(handle); }
    if (e.event === "item") {
      items.set(e.data.id, e.data);
      await hooks.onItem?.(e.data, handle);
    }
  }
  return { run: handle.run, items: [...items.values()], events, handle };
}

export const textOf = (r: Run): string =>
  r.result?.kind === "text" ? r.result.text : r.result?.kind === "data" ? JSON.stringify(r.result.data) : "";

export const actions = (items: Item[]) => items.filter((i): i is Extract<Item, { type: "action" }> => i.type === "action");

export function describeRun(f: Finished): string {
  const acts = actions(f.items).map((a) => `${a.action.kind}:${a.status}`).join(",");
  return `status=${f.run.status} error=${JSON.stringify(f.run.error ?? null)} result=${JSON.stringify(textOf(f.run)).slice(0, 300)} actions=[${acts}]`;
}

export function pgrep(pattern: string): string[] {
  try {
    return execFileSync("pgrep", ["-f", pattern]).toString().trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, step = 250): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return cond();
}

/** A unique, pronounceable token so every run asserts on something the model cannot guess. */
export function token(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

export const text = (t: string) => [{ kind: "text" as const, text: t }];
