import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { spawnInGroup, tail, TailBuffer, terminateProcessGroup } from "../common.ts";

type Json = Record<string, unknown>;
type State = "open" | "closing" | "closed";
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export type ServerRequestHandler = (method: string, params: Json) => Promise<unknown>;
export type NotificationHandler = (method: string, params: Json) => void;

export class RpcError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) { super(message); this.code = code; }
}

export class CodexRpc {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readonly stderr = new TailBuffer();
  private state: State = "open";
  private terminalError?: Error;
  private closePromise?: Promise<void>;
  readonly exited: Promise<number | null>;
  onRequest: ServerRequestHandler = async (method) => { throw new RpcError(`unsupported: ${method}`, -32601); };
  onNotification: NotificationHandler = () => {};

  constructor(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawnInGroup(command, [...args, "app-server"], { cwd, env });
    this.child.stderr?.on("data", (chunk: Buffer) => this.stderr.append(chunk));
    this.child.stdin?.on("error", (error) => this.fail(error));
    this.child.stdout?.on("error", (error) => this.fail(error));
    this.exited = new Promise((resolve) => {
      this.child.once("exit", (code) => {
        this.fail(new RpcError(`codex app-server exited${this.stderrTail(2000) ? `: ${this.stderrTail(2000)}` : ""}`));
        resolve(code);
      });
      this.child.once("error", (error) => { this.fail(error); resolve(null); });
    });
    createInterface({ input: this.child.stdout! }).on("line", (line) => this.onLine(line));
  }

  stderrTail(length: number): string {
    return tail(this.stderr.toString(), length);
  }

  request<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.state !== "open" || !this.child.stdin?.writable) return Promise.reject(this.terminalError ?? new RpcError("codex RPC channel is closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.rejectPending(id, new RpcError(`${method} timed out after ${timeoutMs}ms`)), timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.write({ id, method, params }, (error) => { if (error) this.fail(error); });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.state !== "open") return;
    this.write(params === undefined ? { method } : { method, params }, (error) => { if (error) this.fail(error); });
  }

  async initialize(version: string): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "bo", version }, capabilities: { experimentalApi: false } });
    this.notify("initialized");
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.state === "open") {
      this.state = "closing";
      this.rejectAll(this.terminalError ?? new RpcError("codex RPC channel is closing"));
    }
    this.closePromise = terminateProcessGroup(this.child, () => this.child.stdin?.end())
      .finally(() => { this.state = "closed"; });
    return this.closePromise;
  }

  private write(message: Json, callback: (error?: Error) => void): void {
    this.child.stdin!.write(`${JSON.stringify(message)}\n`, (error) => callback(error ?? undefined));
  }

  private onLine(line: string): void {
    if (!line.trim() || this.state === "closed") return;
    let message: Json;
    try { message = JSON.parse(line) as Json; }
    catch { this.fail(new RpcError("codex emitted malformed JSON")); return; }
    const id = message.id;
    if (id !== undefined && typeof message.method === "string") {
      if (typeof id !== "number" && typeof id !== "string") { this.fail(new RpcError("codex emitted an invalid request id")); return; }
      void this.onRequest(message.method, asObject(message.params)).then(
        (result) => this.state === "open" && this.write({ id, result }, (error) => { if (error) this.fail(error); }),
        (error: unknown) => this.state === "open" && this.write({
          id, error: { code: error instanceof RpcError && error.code ? error.code : -32603, message: asError(error).message },
        }, (writeError) => { if (writeError) this.fail(writeError); }),
      );
      return;
    }
    if (id !== undefined) {
      if (typeof id !== "number") { this.fail(new RpcError("codex emitted an invalid response id")); return; }
      // An id that is no longer pending belongs to a request that already timed out: its late answer is dropped.
      const pending = this.takePending(id);
      if (!pending) return;
      if (message.error) {
        const error = asObject(message.error);
        pending.reject(new RpcError(String(error.message ?? "RPC error"), typeof error.code === "number" ? error.code : undefined));
      } else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") {
      try { this.onNotification(message.method, asObject(message.params)); }
      catch (error) { this.fail(asError(error)); }
      return;
    }
    this.fail(new RpcError("codex emitted an invalid RPC message"));
  }

  private takePending(id: number): Pending | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    return pending;
  }

  private rejectPending(id: number, error: Error): void {
    this.takePending(id)?.reject(error);
  }

  private rejectAll(error: Error): void {
    for (const id of [...this.pending.keys()]) this.rejectPending(id, error);
  }

  private fail(error: Error): void {
    if (!this.terminalError) this.terminalError = error;
    this.rejectAll(this.terminalError);
    if (this.state === "open") void this.close();
  }
}

function asObject(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
