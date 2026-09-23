import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { startServer, type BoServer } from "../src/http/server.ts";
import type { Outcome, RunIO } from "../src/harness/port.ts";
import { encodeSession } from "../src/ids.ts";
import type { ResolvedSpec } from "../src/spec.ts";
import { ok, scripted, sleep, tmpdir } from "./helpers.ts";

const servers: BoServer[] = [];
after(async () => { await Promise.all(servers.map((s) => s.close())); });

async function boot(script: (s: unknown, io: RunIO) => Promise<Outcome>, env: Record<string, string> = {}) {
  const s = await startServer({ port: 0, env: { PATH: process.env.PATH ?? "", ...env }, engines: [scripted("claude-code", script)], sessionsFile: null });
  servers.push(s);
  return s;
}

const rpc = (url: string, method: string, params: unknown, version = "1.0") =>
  fetch(`${url}/a2a`, { method: "POST", headers: { "content-type": "application/json", "a2a-version": version, "a2a-extensions": "urn:bo:a2a:run:v1" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }) });

test("agent card", async () => {
  const s = await boot(async () => ok());
  const card = await (await fetch(`${s.url}/.well-known/agent-card.json`)).json() as Record<string, unknown>;
  assert.equal(card.name, "bo");
  assert.deepEqual((card.supportedInterfaces as unknown[])[0], { url: `${s.url}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" });
  assert.equal((card.skills as { id: string }[])[0]!.id, "claude-code");
  assert.equal((card.capabilities as { extensions: { uri: string }[] }).extensions[0]!.uri, "urn:bo:a2a:run:v1");
});

test("SendMessage blocks until completion and returns a result artifact", async () => {
  const root = await tmpdir();
  const s = await boot(async () => ok("42"), { BO_A2A_WORKSPACE: root });
  const r = await (await rpc(s.url, "SendMessage", { message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "answer" }] } })).json() as { result: { task: Record<string, unknown> } };
  const task = r.result.task;
  assert.equal((task.status as { state: string }).state, "TASK_STATE_COMPLETED");
  assert.deepEqual(task.artifacts, [{ artifactId: "result", name: "result", parts: [{ text: "42", mediaType: "text/plain" }] }]);
  const got = await (await rpc(s.url, "GetTask", { id: task.id })).json() as { result: { id: string } };
  assert.equal(got.result.id, task.id);
  const cancel = await (await rpc(s.url, "CancelTask", { id: task.id })).json() as { error: { code: number } };
  assert.equal(cancel.error.code, -32002);
});

test("input-required, then respond via a data part", async () => {
  const s = await boot(async (_s, io) => {
    const r = await io.await("a", { type: "action", action: { kind: "shell", command: "rm x" }, status: "awaiting_approval" });
    return ok(r && "decision" in r ? r.decision : "none");
  });
  const root = await tmpdir();
  const first = await (await rpc(s.url, "SendMessage", {
    message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "go" }], metadata: { "urn:bo:a2a:run:v1": { workspace: { root }, interactive: true } } },
  })).json() as { result: { task: { id: string; status: { state: string } } } };
  assert.equal(first.result.task.status.state, "TASK_STATE_INPUT_REQUIRED");
  const pending = (first.result.task.status as unknown as { message: { parts: { data: { id: string; type: string } }[] } }).message.parts[0]!.data;
  assert.equal(pending.type, "action");
  const answered = await (await rpc(s.url, "SendMessage", {
    message: { messageId: "m2", role: "ROLE_USER", taskId: first.result.task.id, parts: [{ data: { item_id: pending.id, response: { decision: "allow" } } }] },
  })).json() as { result: { task: { status: { state: string } } } };
  assert.ok(["TASK_STATE_WORKING", "TASK_STATE_COMPLETED"].includes(answered.result.task.status.state));
  for (let i = 0; i < 50; i++) {
    const t = await (await rpc(s.url, "GetTask", { id: first.result.task.id })).json() as { result: { status: { state: string }; artifacts: { parts: { text: string }[] }[] } };
    if (t.result.status.state === "TASK_STATE_COMPLETED") {
      assert.equal(t.result.artifacts[0]!.parts[0]!.text, "allow");
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("task never completed");
});

test("streaming, version and error mapping", async () => {
  const root = await tmpdir();
  const s = await boot(async (_s, io) => {
    io.upsert("m", { type: "message", role: "agent", content: [{ kind: "text", text: "hi" }], status: "completed" });
    return ok("done");
  }, { BO_A2A_WORKSPACE: root });
  const res = await rpc(s.url, "SendStreamingMessage", { message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "go" }] } });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(res.headers.get("a2a-extensions"), "urn:bo:a2a:run:v1", "activated before the stream starts");
  const lines = (await res.text()).split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as { result: Record<string, unknown> });
  assert.ok("task" in lines[0]!.result);
  assert.ok(lines.some((l) => "artifactUpdate" in l.result));
  const final = lines.at(-1)!.result.statusUpdate as { status: { state: string } };
  assert.equal(final.status.state, "TASK_STATE_COMPLETED");
  assert.ok(lines.some((l) => ((l.result.statusUpdate as { status?: { message?: { parts?: { text?: string }[] } } } | undefined)?.status?.message?.parts?.[0]?.text) === "hi"));

  const noVersion = await (await rpc(s.url, "GetTask", { id: "x" }, "")).json() as { error: { code: number } };
  assert.equal(noVersion.error.code, -32009);
  const missing = await (await rpc(s.url, "GetTask", { id: "x" })).json() as { error: { code: number } };
  assert.equal(missing.error.code, -32001);
  const unknown = await (await rpc(s.url, "Nope", {})).json() as { error: { code: number } };
  assert.equal(unknown.error.code, -32601);
  const raw = await (await rpc(s.url, "SendMessage", { message: { messageId: "m", role: "ROLE_USER", parts: [{ raw: "AAAA" }] } })).json() as { error: { code: number } };
  assert.equal(raw.error.code, -32005);
});

test("workspace is required without the extension or BO_A2A_WORKSPACE", async () => {
  const s = await boot(async () => ok());
  const r = await (await rpc(s.url, "SendMessage", { message: { messageId: "m", role: "ROLE_USER", parts: [{ text: "x" }] } })).json() as { error: { code: number; message: string } };
  assert.equal(r.error.code, -32602);
  assert.match(r.error.message, /workspace required/);
});

test("ListTasks applies pagination and artifact projection", async () => {
  const root = await tmpdir();
  const s = await boot(async () => ok("done"), { BO_A2A_WORKSPACE: root });
  for (const id of ["m1", "m2"]) await (await rpc(s.url, "SendMessage", {
    message: { messageId: id, role: "ROLE_USER", parts: [{ text: id }] }, configuration: { returnImmediately: false },
  })).json();
  const first = await (await rpc(s.url, "ListTasks", { pageSize: 1, includeArtifacts: false })).json() as {
    result: { tasks: { artifacts?: unknown[] }[]; pageSize: number; totalSize: number; nextPageToken: string };
  };
  assert.equal(first.result.pageSize, 1);
  assert.equal(first.result.totalSize, 2);
  assert.ok(first.result.nextPageToken);
  assert.deepEqual(first.result.tasks[0]!.artifacts ?? [], []);
  const second = await (await rpc(s.url, "ListTasks", { pageSize: 1, pageToken: first.result.nextPageToken, includeArtifacts: true })).json() as {
    result: { tasks: { artifacts: unknown[] }[]; nextPageToken: string };
  };
  assert.equal(second.result.tasks[0]!.artifacts.length, 1);
  assert.equal(second.result.nextPageToken, "");
});

type TaskResult = { result: { task: { id: string; contextId: string; status: { state: string } } } };

test("contexts: continuation uses the latest session, an explicit session wins, /v1 runs get a stable context", async () => {
  const seen: ResolvedSpec[] = [];
  const root = await tmpdir();
  const s = await boot(async (spec, io) => {
    const r = spec as ResolvedSpec;
    seen.push(r);
    io.session(r.session?.native ?? `native-${seen.length}`);
    return ok();
  }, { BO_A2A_WORKSPACE: root });
  const send = async (messageId: string, contextId?: string, metadata?: Record<string, unknown>) => (await (await rpc(s.url, "SendMessage", {
    message: { messageId, role: "ROLE_USER", parts: [{ text: messageId }], ...(contextId ? { contextId } : {}), ...(metadata ? { metadata } : {}) },
  })).json() as TaskResult).result.task;

  const first = await send("m1");
  await send("m2", first.contextId);
  assert.equal(seen[1]!.session?.native, "native-1", "the context continues its session");
  const explicit = encodeSession("claude-code", "explicit-1");
  await send("m3", first.contextId, { "urn:bo:a2a:run:v1": { session: { id: explicit } } });
  assert.equal(seen[2]!.session?.native, "explicit-1", "an explicit session is never overridden");

  const v1 = await (await fetch(`${s.url}/v1/runs`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: [{ kind: "text", text: "x" }], workspace: { root } }),
  })).json() as { id: string };
  const get = async () => (await (await rpc(s.url, "GetTask", { id: v1.id })).json() as { result: { contextId: string } }).result.contextId;
  const before = await get();
  await send("m4");
  assert.equal(await get(), before);
  assert.equal(before, `ctx_${v1.id}`);
});

test("a context continues its session across a server restart (the session index is durable)", async () => {
  const root = await tmpdir();
  const sessionsFile = path.join(await tmpdir(), "sessions.json");
  const seen: (string | undefined)[] = [];
  const script = async (spec: unknown, io: RunIO) => {
    const r = spec as ResolvedSpec;
    seen.push(r.session?.native);
    io.session(r.session?.native ?? "native-first");
    return ok();
  };
  const send = async (url: string, contextId?: string) => (await (await rpc(url, "SendMessage", {
    message: { messageId: `m${seen.length}`, role: "ROLE_USER", parts: [{ text: "hi" }], ...(contextId ? { contextId } : {}) },
  })).json() as TaskResult).result.task;
  const first = await startServer({ port: 0, env: { PATH: process.env.PATH ?? "", BO_A2A_WORKSPACE: root }, engines: [scripted("claude-code", script)], sessionsFile });
  const task = await send(first.url);
  await first.close();
  const second = await startServer({ port: 0, env: { PATH: process.env.PATH ?? "", BO_A2A_WORKSPACE: root }, engines: [scripted("claude-code", script)], sessionsFile });
  servers.push(second);
  await send(second.url, task.contextId);
  assert.deepEqual(seen, [undefined, "native-first"]);
});

test("errors: spec problems keep their pointers; unusable bodies are JSON-RPC errors", async () => {
  const root = await tmpdir();
  const s = await boot(async () => ok(), { BO_A2A_WORKSPACE: root });
  const bad = await (await rpc(s.url, "SendMessage", {
    message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "x" }], metadata: { "urn:bo:a2a:run:v1": { timeout_s: -1 } } },
  })).json() as { error: { message: string } };
  assert.match(bad.error.message, /\/timeout_s must be an integer 1–86400/);
  const notJson = await (await fetch(`${s.url}/a2a`, { method: "POST", headers: { "content-type": "application/json", "a2a-version": "1.0" }, body: "{" })).json() as { error: { code: number } };
  assert.equal(notJson.error.code, -32700);
  const wrongType = await (await fetch(`${s.url}/a2a`, { method: "POST", headers: { "content-type": "text/plain", "a2a-version": "1.0" }, body: "{}" })).json() as { error: { code: number; message: string } };
  assert.deepEqual(wrongType.error, { code: -32600, message: "content-type must be application/json" });
});
