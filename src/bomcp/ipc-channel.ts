import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import type { IpcToolCallRequest, IpcToolCallResponse } from "./types.ts";
import { reportInternalError } from "../internal-reporting.ts";

// Line-delimited JSON over Unix domain socket.

const DEFAULT_IPC_CALL_TIMEOUT_MS = 30_000;
const MAX_IPC_BUFFER_BYTES = 256 * 1024;

export interface IpcServer {
  readonly socketPath: string;
  start(handler: (req: IpcToolCallRequest) => Promise<IpcToolCallResponse>): Promise<void>;
  stop(): Promise<void>;
}

export interface IpcClient {
  connect(): Promise<void>;
  callTool(request: IpcToolCallRequest, options?: { timeoutMs?: number }): Promise<IpcToolCallResponse>;
  disconnect(): void;
}

export function createIpcServer(socketPath: string): IpcServer {
  let server: net.Server | undefined;
  const connections = new Set<net.Socket>();

  return {
    socketPath,

    async start(handler) {
      const dir = path.dirname(socketPath);
      fs.mkdirSync(dir, { recursive: true });

      // Remove stale socket if it exists
      try { fs.unlinkSync(socketPath); } catch { /* ignore */ }

      server = net.createServer((conn) => {
        connections.add(conn);
        let buffer = "";
        conn.setEncoding("utf8");
        conn.on("close", () => {
          connections.delete(conn);
        });
        conn.on("error", (err) => {
          reportInternalError("bomcp.ipc.server.connection", err, { socket_path: socketPath });
        });
        conn.on("data", (chunk: string) => {
          buffer += chunk;
          if (buffer.length > MAX_IPC_BUFFER_BYTES) {
            reportInternalError("bomcp.ipc.server.frame_too_large", new Error("IPC request buffer exceeded limit"), {
              socket_path: socketPath,
              buffered_bytes: buffer.length,
            });
            conn.destroy(new Error("IPC request buffer exceeded limit"));
            return;
          }
          let newlineIndex: number;
          while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (!line.trim()) continue;
            void handleLine(line, conn, handler).catch((err) => {
              reportInternalError("bomcp.ipc.server.handle_line", err, { socket_path: socketPath });
              conn.destroy(err instanceof Error ? err : new Error(String(err)));
            });
          }
        });
      });

      await new Promise<void>((resolve, reject) => {
        server!.on("error", reject);
        server!.listen(socketPath, () => resolve());
      });
    },

    async stop() {
      if (!server) return;
      for (const conn of connections) {
        conn.destroy();
      }
      connections.clear();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
      server = undefined;
    },
  };
}

async function handleLine(
  line: string,
  conn: net.Socket,
  handler: (req: IpcToolCallRequest) => Promise<IpcToolCallResponse>,
): Promise<void> {
  let requestId = "unknown";
  let req: IpcToolCallRequest | undefined;
  try {
    req = JSON.parse(line) as IpcToolCallRequest;
    requestId = req.request_id ?? requestId;
    if (!isIpcToolCallRequest(req)) {
      throw new Error("invalid IPC tool call request");
    }
  } catch (err) {
    reportInternalError("bomcp.ipc.server.malformed_request", err, {
      request_id: requestId,
      line_preview: line.slice(0, 200),
    });
    conn.destroy(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  try {
    const resp = await handler(req);
    await writeFrame(conn, JSON.stringify(resp) + "\n");
  } catch (err) {
    const resp: IpcToolCallResponse = {
      type: "tool_response",
      request_id: requestId,
      error: { code: "internal", message: String(err) },
    };
    await writeFrame(conn, JSON.stringify(resp) + "\n");
  }
}

export function createIpcClient(socketPath: string): IpcClient {
  let conn: net.Socket | undefined;
  const pending = new Map<string, PendingRequest>();
  let buffer = "";

  return {
    async connect() {
      const socket = net.createConnection(socketPath);
      conn = socket;
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > MAX_IPC_BUFFER_BYTES) {
          const error = new Error("IPC response buffer exceeded limit");
          reportInternalError("bomcp.ipc.client.frame_too_large", error, {
            socket_path: socketPath,
            buffered_bytes: buffer.length,
          });
          socket.destroy(error);
          rejectPending(error);
          return;
        }
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.trim()) continue;
          try {
            const resp = JSON.parse(line) as IpcToolCallResponse;
            const waiter = pending.get(resp.request_id);
            if (waiter) {
              settlePending(resp.request_id, waiter, { type: "resolve", response: resp });
            } else {
              reportInternalError("bomcp.ipc.client.unknown_request_id", new Error("received response for unknown request"), {
                socket_path: socketPath,
                request_id: resp.request_id,
              });
            }
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            reportInternalError("bomcp.ipc.client.malformed_response", error, {
              socket_path: socketPath,
              line_preview: line.slice(0, 200),
            });
            socket.destroy(error);
            rejectPending(error);
            return;
          }
        }
      });
      socket.on("error", (err) => {
        reportInternalError("bomcp.ipc.client.connection", err, { socket_path: socketPath });
        rejectPending(err);
      });
      socket.on("close", () => {
        if (conn === socket) {
          conn = undefined;
        }
        rejectPending(new Error("IPC connection closed"));
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
    },

    async callTool(request, options) {
      if (!conn) throw new Error("IPC client not connected");
      return new Promise<IpcToolCallResponse>((resolve, reject) => {
        const timeoutMs = normalizeTimeoutMs(options?.timeoutMs);
        const entry: PendingRequest = {
          settled: false,
          resolve,
          reject,
        };
        const timer = setTimeout(() => {
          if (pending.get(request.request_id) !== entry) {
            return;
          }
          settlePending(request.request_id, entry, {
            type: "reject",
            error: new Error(`IPC call timed out after ${timeoutMs}ms`),
          });
        }, timeoutMs);
        entry.timer = timer;
        pending.set(request.request_id, entry);
        writeFrame(conn!, JSON.stringify(request) + "\n").catch((err) => {
          if (pending.get(request.request_id) !== entry) {
            return;
          }
          settlePending(request.request_id, entry, {
            type: "reject",
            error: err instanceof Error ? err : new Error(String(err)),
          });
        });
      });
    },

    disconnect() {
      if (conn) {
        const socket = conn;
        conn = undefined;
        socket.destroy();
      }
      rejectPending(new Error("IPC client disconnected"));
    },
  };

  function rejectPending(error: Error): void {
    for (const [requestId, waiter] of [...pending.entries()]) {
      settlePending(requestId, waiter, { type: "reject", error });
    }
  }

  function settlePending(
    requestId: string,
    waiter: PendingRequest,
    outcome:
      | { type: "resolve"; response: IpcToolCallResponse }
      | { type: "reject"; error: Error },
  ): void {
    if (pending.get(requestId) !== waiter || waiter.settled) {
      if (outcome.type === "resolve") {
        reportInternalError("bomcp.ipc.client.late_response", new Error("response arrived after waiter was settled"), {
          socket_path: socketPath,
          request_id: requestId,
        });
      }
      return;
    }
    waiter.settled = true;
    pending.delete(requestId);
    if (waiter.timer) {
      clearTimeout(waiter.timer);
    }
    if (outcome.type === "resolve") {
      waiter.resolve(outcome.response);
    } else {
      waiter.reject(outcome.error);
    }
  }
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_IPC_CALL_TIMEOUT_MS;
  }
  return Math.floor(value);
}

interface PendingRequest {
  settled: boolean;
  resolve: (response: IpcToolCallResponse) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

function isIpcToolCallRequest(value: unknown): value is IpcToolCallRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.type === "tool_call"
    && typeof record.tool_name === "string"
    && typeof record.request_id === "string"
    && "params" in record;
}

async function writeFrame(conn: net.Socket, frame: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    conn.write(frame, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}
