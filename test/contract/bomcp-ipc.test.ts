import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as net from "node:net";
import { createIpcServer, createIpcClient } from "../../src/bomcp/ipc-channel.ts";
import type { IpcToolCallRequest, IpcToolCallResponse } from "../../src/bomcp/types.ts";

let unixSocketSupportPromise: Promise<boolean> | undefined;

function tmpSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bomcp-ipc-test-"));
  return path.join(dir, "test.sock");
}

async function requireUnixSocketSupport(t: { skip: (message?: string) => never | void }): Promise<void> {
  const supported = await supportsUnixSockets();
  if (!supported) {
    t.skip("Unix domain sockets are not available in this environment");
  }
}

function supportsUnixSockets(): Promise<boolean> {
  if (!unixSocketSupportPromise) {
    unixSocketSupportPromise = probeUnixSocketSupport();
  }
  return unixSocketSupportPromise;
}

async function probeUnixSocketSupport(): Promise<boolean> {
  const socketPath = tmpSocketPath();
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    return true;
  } catch {
    return false;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => {});
    try {
      fs.unlinkSync(socketPath);
    } catch {}
    try {
      fs.rmdirSync(path.dirname(socketPath));
    } catch {}
  }
}

test("IPC server and client round-trip a tool call", async (t) => {
  await requireUnixSocketSupport(t);
  const socketPath = tmpSocketPath();
  const server = createIpcServer(socketPath);
  await server.start(async (req: IpcToolCallRequest): Promise<IpcToolCallResponse> => {
    return {
      type: "tool_response",
      request_id: req.request_id,
      result: { echo: req.params },
    };
  });

  const client = createIpcClient(socketPath);
  await client.connect();

  const resp = await client.callTool({
    type: "tool_call",
    tool_name: "bomcp.progress.update",
    params: { phase: "testing" },
    request_id: "req_1",
  });

  assert.equal(resp.type, "tool_response");
  assert.equal(resp.request_id, "req_1");
  assert.deepEqual(resp.result, { echo: { phase: "testing" } });

  client.disconnect();
  await server.stop();
});

test("IPC server handles multiple sequential calls", async (t) => {
  await requireUnixSocketSupport(t);
  const socketPath = tmpSocketPath();
  const server = createIpcServer(socketPath);
  let callCount = 0;
  await server.start(async (req): Promise<IpcToolCallResponse> => {
    callCount++;
    return { type: "tool_response", request_id: req.request_id, result: { n: callCount } };
  });

  const client = createIpcClient(socketPath);
  await client.connect();

  const r1 = await client.callTool({ type: "tool_call", tool_name: "t1", params: {}, request_id: "a" });
  const r2 = await client.callTool({ type: "tool_call", tool_name: "t2", params: {}, request_id: "b" });
  const r3 = await client.callTool({ type: "tool_call", tool_name: "t3", params: {}, request_id: "c" });

  assert.deepEqual(r1.result, { n: 1 });
  assert.deepEqual(r2.result, { n: 2 });
  assert.deepEqual(r3.result, { n: 3 });

  client.disconnect();
  await server.stop();
});

test("IPC server returns error for handler exceptions", async (t) => {
  await requireUnixSocketSupport(t);
  const socketPath = tmpSocketPath();
  const server = createIpcServer(socketPath);
  await server.start(async (): Promise<IpcToolCallResponse> => {
    throw new Error("handler exploded");
  });

  const client = createIpcClient(socketPath);
  await client.connect();

  const resp = await client.callTool({
    type: "tool_call",
    tool_name: "bomcp.control.handoff",
    params: {},
    request_id: "req_err",
  });

  assert.ok(resp.error);
  assert.match(resp.error!.message, /handler exploded/);

  client.disconnect();
  await server.stop();
});

test("IPC client times out stalled tool calls", async (t) => {
  await requireUnixSocketSupport(t);
  const socketPath = tmpSocketPath();
  const server = createIpcServer(socketPath);
  await server.start(async () => {
    await new Promise(() => {});
    return { type: "tool_response", request_id: "never", result: {} };
  });

  const client = createIpcClient(socketPath);
  await client.connect();

  await assert.rejects(
    () => client.callTool({
      type: "tool_call",
      tool_name: "bomcp.progress.update",
      params: { phase: "testing" },
      request_id: "req_timeout",
    }, { timeoutMs: 10 }),
    /timed out/i,
  );

  client.disconnect();
  await server.stop();
});

test("IPC client rejects when the socket closes before a response arrives", async (t) => {
  await requireUnixSocketSupport(t);
  const socketPath = tmpSocketPath();
  const server = net.createServer((conn) => {
    conn.setEncoding("utf8");
    conn.once("data", () => {
      conn.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  const client = createIpcClient(socketPath);
  await client.connect();

  await assert.rejects(
    () => client.callTool({
      type: "tool_call",
      tool_name: "bomcp.progress.update",
      params: { phase: "testing" },
      request_id: "req_close",
    }),
    /closed|disconnected/i,
  );

  client.disconnect();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("IPC client tolerates unknown request ids and still resolves the matching response", async (t) => {
  await requireUnixSocketSupport(t);
  const socketPath = tmpSocketPath();
  const server = net.createServer((conn) => {
    conn.setEncoding("utf8");
    let buffer = "";
    conn.on("data", (chunk: string) => {
      buffer += chunk;
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line) as IpcToolCallRequest;
        conn.write(JSON.stringify({
          type: "tool_response",
          request_id: "req_unknown",
          result: { ignored: true },
        }) + "\n");
        conn.write(JSON.stringify({
          type: "tool_response",
          request_id: req.request_id,
          result: { ok: true },
        }) + "\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  const client = createIpcClient(socketPath);
  await client.connect();

  const resp = await client.callTool({
    type: "tool_call",
    tool_name: "bomcp.progress.update",
    params: { phase: "testing" },
    request_id: "req_known",
  });

  assert.deepEqual(resp.result, { ok: true });

  client.disconnect();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("IPC client rejects oversized response frames", async (t) => {
  await requireUnixSocketSupport(t);
  const socketPath = tmpSocketPath();
  const server = net.createServer((conn) => {
    conn.setEncoding("utf8");
    conn.once("data", () => {
      conn.write("x".repeat(300 * 1024));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  const client = createIpcClient(socketPath);
  await client.connect();

  await assert.rejects(
    () => client.callTool({
      type: "tool_call",
      tool_name: "bomcp.progress.update",
      params: { phase: "testing" },
      request_id: "req_large",
    }),
    /buffer exceeded/i,
  );

  client.disconnect();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("late responses after timeout do not corrupt later requests", async (t) => {
  await requireUnixSocketSupport(t);
  const socketPath = tmpSocketPath();
  const server = net.createServer((conn) => {
    conn.setEncoding("utf8");
    let buffer = "";
    conn.on("data", (chunk: string) => {
      buffer += chunk;
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line) as IpcToolCallRequest;
        if (req.request_id === "req_slow") {
          setTimeout(() => {
            conn.write(JSON.stringify({
              type: "tool_response",
              request_id: req.request_id,
              result: { slow: true },
            }) + "\n");
          }, 40);
          continue;
        }
        conn.write(JSON.stringify({
          type: "tool_response",
          request_id: req.request_id,
          result: { fast: true },
        }) + "\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  const client = createIpcClient(socketPath);
  await client.connect();

  await assert.rejects(
    () => client.callTool({
      type: "tool_call",
      tool_name: "bomcp.progress.update",
      params: { phase: "slow" },
      request_id: "req_slow",
    }, { timeoutMs: 10 }),
    /timed out/i,
  );

  await new Promise((resolve) => setTimeout(resolve, 60));

  const resp = await client.callTool({
    type: "tool_call",
    tool_name: "bomcp.progress.update",
    params: { phase: "fast" },
    request_id: "req_fast",
  });

  assert.deepEqual(resp.result, { fast: true });

  client.disconnect();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("IPC socket is cleaned up on server stop", async (t) => {
  await requireUnixSocketSupport(t);
  const socketPath = tmpSocketPath();
  const server = createIpcServer(socketPath);
  await server.start(async (req): Promise<IpcToolCallResponse> => ({
    type: "tool_response", request_id: req.request_id, result: {},
  }));
  assert.ok(fs.existsSync(socketPath));
  await server.stop();
  assert.ok(!fs.existsSync(socketPath));
});
