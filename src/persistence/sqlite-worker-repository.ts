import { Worker } from "node:worker_threads";
import type {
  AppendExecutionEventInput,
  BoStaffRepository,
  CommitTerminalExecutionInput,
  ExecutionEventPage,
  ExecutionEventPageCursor,
  InitializeExecutionInput,
  SessionPage,
  SessionPageCursor,
  SessionRecord,
  StoredExecutionSnapshot
} from "./types.ts";
import type { BoStaffEvent } from "../types.ts";

interface WorkerRequest {
  id: number;
  method: keyof BoStaffRepository;
  args: unknown[];
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
    httpStatus?: number;
  };
}

export class WorkerThreadSqliteBoStaffRepository implements BoStaffRepository {
  private readonly worker: Worker;
  private nextId = 1;
  private closed = false;
  private closing?: Promise<void>;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }>();

  constructor(dataDir: string) {
    this.worker = new Worker(new URL("./sqlite-worker.ts", import.meta.url), {
      workerData: { dataDir }
    });
    this.worker.on("message", (message: WorkerResponse) => {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.ok) {
        pending.resolve(message.value);
        return;
      }
      pending.reject(rehydrateWorkerError(message.error));
    });
    this.worker.on("error", (error) => {
      this.closed = true;
      this.rejectAllPending(error);
    });
    this.worker.on("exit", (code) => {
      if (!this.closed && code !== 0) {
        this.closed = true;
        this.rejectAllPending(new Error(`SQLite worker exited with code ${code}`));
      }
    });
  }

  async getSession(handle: string): Promise<SessionRecord | undefined> {
    return this.request("getSession", handle);
  }

  async listSessionsPage(input: { limit: number; after?: SessionPageCursor }): Promise<SessionPage> {
    return this.request("listSessionsPage", input);
  }

  async countSessions(): Promise<number> {
    return this.request("countSessions");
  }

  async getExecution(executionId: string): Promise<StoredExecutionSnapshot | undefined> {
    return this.request("getExecution", executionId);
  }

  async getExecutionEvents(executionId: string): Promise<BoStaffEvent[]> {
    return this.request("getExecutionEvents", executionId);
  }

  async getExecutionEventsPage(input: {
    execution_id: string;
    limit: number;
    after?: ExecutionEventPageCursor;
  }): Promise<ExecutionEventPage> {
    return this.request("getExecutionEventsPage", input);
  }

  async pruneSessionlessTerminalExecutions(before: string): Promise<number> {
    return this.request("pruneSessionlessTerminalExecutions", before);
  }

  async deleteSession(handle: string): Promise<boolean> {
    return this.request("deleteSession", handle);
  }

  async recoverInterruptedExecutions(): Promise<void> {
    await this.request("recoverInterruptedExecutions");
  }

  async initializeExecution(input: InitializeExecutionInput): Promise<void> {
    await this.request("initializeExecution", input);
  }

  async appendExecutionEvent(input: AppendExecutionEventInput): Promise<number> {
    return this.request("appendExecutionEvent", input);
  }

  async commitTerminalExecution(input: CommitTerminalExecutionInput): Promise<void> {
    await this.request("commitTerminalExecution", input);
  }

  async close(): Promise<void> {
    if (this.closing) {
      return this.closing;
    }
    if (this.closed) {
      return;
    }
    this.closing = (async () => {
      try {
        await this.request<void>("close");
      } finally {
        this.closed = true;
        await this.worker.terminate();
        this.rejectAllPending(new Error("SQLite worker repository closed"));
      }
    })();
    return this.closing;
  }

  private async request<T>(method: keyof BoStaffRepository, ...args: unknown[]): Promise<T> {
    if (this.closed) {
      throw new Error("SQLite worker repository is closed");
    }
    const id = this.nextId++;
    const payload: WorkerRequest = { id, method, args };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      });
      try {
        this.worker.postMessage(payload);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private rejectAllPending(error: unknown): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function rehydrateWorkerError(error?: {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  httpStatus?: number;
}): Error {
  const value = new Error(error?.message ?? "SQLite worker request failed");
  value.name = error?.name ?? "Error";
  value.stack = error?.stack ?? value.stack;
  if (error?.code) {
    (value as Error & { code?: string }).code = error.code;
  }
  if (typeof error?.httpStatus === "number") {
    (value as Error & { httpStatus?: number }).httpStatus = error.httpStatus;
  }
  return value;
}
