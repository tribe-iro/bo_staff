import { spawn, execFile, type ChildProcess } from "node:child_process";
import { access, cp, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { AuthKind, Part, Question, Response } from "../model.ts";

export type OrderedInput =
  | { kind: "text"; text: string }
  | { kind: "image"; path: string; mediaType: string };

export function orderedInput(parts: readonly Part[]): OrderedInput[] {
  return parts.map((part) => part.kind === "image"
    ? { kind: "image", path: part.path, mediaType: part.media_type }
    : { kind: "text", text: part.kind === "text" ? part.text : `Structured input:\n\`\`\`json\n${JSON.stringify(part.data, null, 2)}\n\`\`\`` });
}

const SERVER_ONLY = /^BO_/;

/** The environment an engine process sees: the server's, minus bo's own configuration (tokens, flags). */
export function engineEnv(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (!SERVER_ONLY.test(key)) out[key] = value;
  return Object.assign(out, extra);
}

export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Copies each skill directory under `root/<name>` (dereferencing links) and returns `root`. */
export async function stageSkills(skills: readonly { name: string; path: string }[], root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  await Promise.all(skills.map((s) => cp(s.path, path.join(root, s.name), { recursive: true, dereference: true })));
  return root;
}

/** Spawns in a fresh process group so the whole tree (CLI, MCP servers, shells) can be signalled at once. */
export function spawnInGroup(command: string, args: readonly string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }): ChildProcess {
  return spawn(command, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
}

export function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // group already gone
  }
}

const TERMINATIONS = new WeakMap<ChildProcess, Promise<void>>();

export function terminateProcessGroup(child: ChildProcess, gentle: () => void = () => {}, stepMs = 2_000): Promise<void> {
  const existing = TERMINATIONS.get(child);
  if (existing) return existing;
  const termination = (async () => {
    try { gentle(); } catch { /* termination continues */ }
    await exitOrDelay(child, stepMs);
    if (!groupAlive(child)) return;
    killGroup(child, "SIGTERM");
    await exitOrDelay(child, stepMs);
    if (groupAlive(child)) killGroup(child, "SIGKILL");
  })();
  TERMINATIONS.set(child, termination);
  return termination;
}

function groupAlive(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  try { process.kill(-child.pid, 0); return true; } catch { return false; }
}

async function exitOrDelay(child: ChildProcess, ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]);
}

export function tail(s: string, n: number): string {
  return s.length > n ? s.slice(s.length - n) : s;
}

export function excerpt(s: string): string {
  return tail(s.trim(), 2000);
}

/** Bounded tail buffer for a process stream. */
export class TailBuffer {
  private data = "";
  private readonly limit: number;
  constructor(limit = 64 * 1024) {
    this.limit = limit;
  }
  append(chunk: string | Buffer): void {
    this.data = tail(this.data + chunk.toString(), this.limit);
  }
  toString(): string {
    return this.data;
  }
}

export async function which(command: string, envPath = process.env.PATH ?? ""): Promise<string | undefined> {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

export function execText(file: string, args: readonly string[], timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

export function parseVersion(text: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1];
}

export const SUBSCRIPTION_REFUSED =
  "logged in with a personal subscription; for personal use, start the server with --allow-subscription-auth "
  + "(or BO_ALLOW_SUBSCRIPTION_AUTH=1), otherwise log the engine in with an API key or cloud credentials";

export function authPolicy(auth: AuthKind, env: NodeJS.ProcessEnv = process.env): { allowed: true } | { allowed: false; reason: string } {
  switch (auth) {
    case "api_key":
    case "cloud_provider":
      return { allowed: true };
    case "subscription":
      return env.BO_ALLOW_SUBSCRIPTION_AUTH === "1" ? { allowed: true } : { allowed: false, reason: SUBSCRIPTION_REFUSED };
    case "none":
      return { allowed: false, reason: "not logged in; log the engine's CLI in (or set its API key) on the server machine" };
  }
}

/** Expands the caller's `answers` against the questions, in question order. */
export function answersFor(questions: readonly Question[], r: Response | undefined): Record<string, string[]> {
  const answers = r && "answers" in r ? r.answers : {};
  return Object.fromEntries(questions.map((q) => [q.id, answers[q.id] ?? []]));
}

export function isAllow(r: Response | undefined): boolean {
  return r !== undefined && "decision" in r && r.decision !== "deny";
}

export function mapValues<V, W>(o: Record<string, V>, f: (v: V, k: string) => W): Record<string, W> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v, k)]));
}
