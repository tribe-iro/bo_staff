// `bo acp` driven by the ACP SDK's own client over in-memory streams, against a bo server with scripted engines.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import * as acp from "@agentclientprotocol/sdk";
import { BoAcpAgent } from "../src/acp/agent.ts";
import { Bo } from "../src/client.ts";
import { startServer, type BoServer } from "../src/http/server.ts";
import type { Outcome, RunIO } from "../src/harness/port.ts";
import type { ResolvedSpec } from "../src/spec.ts";
import { ok, scripted, tmpdir } from "./helpers.ts";

const servers: BoServer[] = [];
after(async () => { await Promise.all(servers.map((s) => s.close())); });

/** One scripted engine; what it does depends on the prompt. */
/** Image files the engine was given, and whether each existed while it ran. */
const imagesSeen: { path: string; existed: boolean }[] = [];

async function engine(spec: ResolvedSpec, io: RunIO): Promise<Outcome> {
  const prompt = spec.input.map((p) => (p.kind === "text" ? p.text : "")).join(" ");
  for (const p of spec.input) if (p.kind === "image") imagesSeen.push({ path: p.path, existed: existsSync(p.path) });
  io.session(spec.session?.native ?? `native-${Math.random().toString(16).slice(2)}`);
  io.model(spec.model ?? "m1");
  const edit = { kind: "edit" as const, changes: [{ path: `${spec.root}/a.txt`, change: "modify" as const, diff: "@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n" }] };
  if (prompt.includes("approve")) {
    const r = await io.await("e", { type: "action", action: edit, status: "awaiting_approval" });
    return ok(r && "decision" in r ? r.decision : "none");
  }
  if (prompt.includes("ask")) {
    const r = await io.await("q", { type: "question", questions: [{ id: "color", text: "Which color?", options: ["red", "blue"], multiple: false }], status: "awaiting_answer" });
    return ok(JSON.stringify(r && "answers" in r ? r.answers : null));
  }
  if (prompt.includes("wait")) {
    io.accept(true);
    const steers: string[] = [];
    const reading = (async () => { for await (const s of io.messages) { s.delivered(); steers.push(s.parts.map((p) => (p.kind === "text" ? p.text : "")).join("")); } })();
    await new Promise((resolve) => { io.signal.addEventListener("abort", resolve); setTimeout(resolve, prompt.includes("briefly") ? 150 : 60_000); });
    void reading;
    return ok(`steered: ${steers.join(",")}`);
  }
  if (prompt.includes("limit")) {
    for (let i = 0; i < 5; i++) io.modelCall(10, true);
    await new Promise((resolve) => io.signal.addEventListener("abort", resolve));
    return ok();
  }
  if (prompt.includes("fail")) return { ok: false, error: { code: "rate_limited", message: "slow down" }, usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 } };
  io.upsert("m", { type: "message", role: "agent", content: [{ kind: "text", text: "" }], status: "in_progress" });
  io.delta("m", "Hel");
  io.delta("m", "lo");
  io.upsert("m", { type: "message", role: "agent", content: [{ kind: "text", text: "Hello" }], status: "completed" });
  io.upsert("r", { type: "reasoning", text: "thinking it over" });
  io.upsert("p", { type: "plan", steps: [{ text: "look", status: "completed" }, { text: "fix", status: "in_progress" }] });
  io.upsert("e", { type: "action", action: edit, status: "running" });
  io.upsert("e", { type: "action", action: edit, status: "completed" });
  io.upsert("x", { type: "action", action: { kind: "shell", command: "npm test" }, status: "completed", outcome: { exit_code: 0, excerpt: "3 passing" } });
  return { ...ok("Hello"), usage: { input_tokens: 100, output_tokens: 7, cached_input_tokens: 40 } };
}

async function boot() {
  const s = await startServer({
    port: 0, env: { PATH: process.env.PATH ?? "" }, sessionsFile: null,
    engines: [scripted("claude-code", engine), scripted("codex", engine)],
  });
  servers.push(s);
  return s;
}

interface Editor {
  agent: acp.ClientSideConnection;
  updates: acp.SessionNotification[];
  permissions: acp.RequestPermissionRequest[];
}

/** An ACP client (the editor) connected to a fresh `bo acp` agent. */
async function connect(url: string, opts: { choose?: (p: acp.RequestPermissionRequest) => acp.RequestPermissionResponse; form?: (r: acp.CreateElicitationRequest) => acp.CreateElicitationResponse; notices?: boolean } = {}): Promise<Editor> {
  const toClient = new TransformStream<Uint8Array>();
  const toAgent = new TransformStream<Uint8Array>();
  new acp.AgentSideConnection((conn) => new BoAcpAgent(conn, new Bo({ url })), acp.ndJsonStream(toClient.writable, toAgent.readable));
  const updates: acp.SessionNotification[] = [];
  const permissions: acp.RequestPermissionRequest[] = [];
  const agent = new acp.ClientSideConnection(() => ({
    sessionUpdate: async (n) => { updates.push(n); },
    requestPermission: async (p) => { permissions.push(p); return opts.choose?.(p) ?? { outcome: { outcome: "selected", optionId: "allow" } }; },
    ...(opts.form ? { createElicitation: async (r: acp.CreateElicitationRequest) => opts.form!(r) } : {}),
  }), acp.ndJsonStream(toAgent.writable, toClient.readable));
  await agent.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { ...(opts.form ? { elicitation: { form: {} } } : {}), ...(opts.notices ? { session: { notices: {} } } : {}) },
  });
  return { agent, updates, permissions };
}

const kinds = (updates: acp.SessionNotification[]) => updates.map((u) => u.update.sessionUpdate);

test("initialize and new session: capabilities, one model picker grouped by engine, effort per model, access modes", async () => {
  const s = await boot();
  const toClient = new TransformStream<Uint8Array>();
  const toAgent = new TransformStream<Uint8Array>();
  new acp.AgentSideConnection((conn) => new BoAcpAgent(conn, new Bo({ url: s.url })), acp.ndJsonStream(toClient.writable, toAgent.readable));
  const agent = new acp.ClientSideConnection(() => ({ sessionUpdate: async () => {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) }), acp.ndJsonStream(toAgent.writable, toClient.readable));
  const init = await agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  assert.equal(init.protocolVersion, 1);
  assert.equal(init.agentCapabilities?.loadSession, true);
  assert.deepEqual(init.agentCapabilities?.sessionCapabilities, { list: {}, resume: {}, close: {}, delete: {}, additionalDirectories: {} });
  const created = await agent.newSession({ cwd: await tmpdir(), mcpServers: [] });
  assert.match(created.sessionId, /^acp:/);
  const [model, effort, mode] = created.configOptions!;
  assert.equal(model!.category, "model");
  assert.deepEqual((model as { options: { group: string }[] }).options.map((g) => g.group), ["claude-code", "codex"], "both engines in one picker");
  assert.equal(model!.currentValue, "claude-code/m1");
  assert.deepEqual((effort as { options: { value: string }[] }).options.map((o) => o.value), ["default", "low", "high"]);
  assert.deepEqual((mode as { options: { value: string }[] }).options.map((o) => o.value), ["read", "write", "write-internet", "full"]);
  assert.equal(created.modes?.currentModeId, "write");
});

test("a prompt is a run: streamed words once, thoughts, plan, tool calls with diffs and output, end_turn with usage", async () => {
  const s = await boot();
  const editor = await connect(s.url);
  const { sessionId } = await editor.agent.newSession({ cwd: await tmpdir(), mcpServers: [] });
  const response = await editor.agent.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] });
  assert.deepEqual(response, { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 7, cachedReadTokens: 40, totalTokens: 107 } });
  const words = editor.updates.filter((u) => u.update.sessionUpdate === "agent_message_chunk").map((u) => (u.update as { content: { text: string } }).content.text);
  assert.equal(words.join(""), "Hello", "the agent's words exactly once, streamed or whole");
  assert.ok(kinds(editor.updates).includes("agent_thought_chunk"));
  assert.deepEqual(editor.updates.find((u) => u.update.sessionUpdate === "plan")!.update, {
    sessionUpdate: "plan", entries: [{ content: "look", status: "completed", priority: "medium" }, { content: "fix", status: "in_progress", priority: "medium" }],
  });
  const editCall = editor.updates.find((u) => u.update.sessionUpdate === "tool_call" && (u.update as acp.ToolCall).kind === "edit")!.update as acp.ToolCall;
  assert.match(editCall.title, /^edit .*a\.txt \(\+1 −1\)$/);
  assert.deepEqual(editCall.content, [{ type: "diff", path: editCall.locations![0]!.path, oldText: "one\ntwo", newText: "one\nTWO" }]);
  const shellDone = editor.updates.map((u) => u.update).find((u) => (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update")
    && (u as acp.ToolCallUpdate).status === "completed" && JSON.stringify((u as acp.ToolCallUpdate).content).includes("3 passing"));
  assert.ok(shellDone, "a finished command shows its output");
});

test("approvals are permission requests: each option maps to a bo decision; a cancelled request denies", async () => {
  const s = await boot();
  for (const [optionId, expected] of [["allow", "allow"], ["allow-run", "allow_for_run"], ["deny", "deny"], [undefined, "deny"]] as const) {
    let result = "";
    const editor = await connect(s.url, { choose: () => (optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } }) });
    const cwd = await tmpdir();
    const { sessionId } = await editor.agent.newSession({ cwd, mcpServers: [] });
    await editor.agent.prompt({ sessionId, prompt: [{ type: "text", text: "approve this" }] });
    const runs = await new Bo({ url: s.url }).sessions.list(await realpath(cwd));
    result = ((await new Bo({ url: s.url }).sessions.runs(runs[0]!.id))[0]!.run.result as { text: string }).text;
    assert.equal(result, expected, `option ${optionId ?? "cancelled"}`);
    const asked = editor.permissions[0]!;
    assert.deepEqual(asked.options.map((o) => [o.optionId, o.kind]), [["allow", "allow_once"], ["allow-run", "allow_always"], ["deny", "reject_once"]]);
    assert.equal(asked.toolCall.kind, "edit");
  }
});

test("questions are elicitation forms when the editor supports them; otherwise the agent gets no answer", async () => {
  const s = await boot();
  const answered = async (form?: (r: acp.CreateElicitationRequest) => acp.CreateElicitationResponse) => {
    const editor = await connect(s.url, form ? { form } : {});
    const cwd = await tmpdir();
    const { sessionId } = await editor.agent.newSession({ cwd, mcpServers: [] });
    await editor.agent.prompt({ sessionId, prompt: [{ type: "text", text: "ask me" }] });
    const bo = new Bo({ url: s.url });
    const [session] = await bo.sessions.list(await realpath(cwd));
    return ((await bo.sessions.runs(session!.id))[0]!.run.result as { text: string }).text;
  };
  let seen: acp.CreateElicitationRequest | undefined;
  assert.equal(await answered((r) => { seen = r; return { action: "accept", content: { color: "blue" } }; }), JSON.stringify({ color: ["blue"] }));
  assert.deepEqual((seen as { requestedSchema: unknown }).requestedSchema, { type: "object", properties: { color: { type: "string", title: "Which color?", enum: ["red", "blue"] } }, required: ["color"] });
  assert.equal(await answered(), JSON.stringify({}));
});

test("cancel ends the turn as cancelled, queued prompts too; steering reaches the running run", async () => {
  const s = await boot();
  const editor = await connect(s.url);
  const { sessionId } = await editor.agent.newSession({ cwd: await tmpdir(), mcpServers: [] });
  const running = editor.agent.prompt({ sessionId, prompt: [{ type: "text", text: "wait here" }] });
  const queued = editor.agent.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(await editor.agent.extMethod("_session/steering", { sessionId, prompt: [{ type: "text", text: "also this" }] }), { outcome: "injected" });
  await editor.agent.cancel({ sessionId });
  assert.equal((await running).stopReason, "cancelled");
  assert.equal((await queued).stopReason, "cancelled");
  assert.ok(editor.updates.some((u) => u.update.sessionUpdate === "user_message_chunk" && (u.update as { content: { text: string } }).content.text === "also this"),
    "the delivered steering message is shown");
  const next = await editor.agent.prompt({ sessionId, prompt: [{ type: "text", text: "wait briefly" }] });
  assert.equal(next.stopReason, "end_turn", "the session goes on after a cancel");
});

test("sessions: list, load (with history), resume (by key or bo id), close, delete; the engine is pinned after the first run", async () => {
  const s = await boot();
  const cwd = await tmpdir();
  const first = await connect(s.url);
  const { sessionId } = await first.agent.newSession({ cwd, mcpServers: [] });
  await first.agent.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] });
  await assert.rejects(first.agent.setSessionConfigOption({ sessionId, configId: "model", value: "codex/m1" }), /keeps its engine/);
  const listed = await first.agent.listSessions({ cwd: await realpath(cwd) });
  assert.deepEqual(listed.sessions.map((x) => [x.sessionId, x.title]), [[sessionId, "hello"]]);

  const second = await connect(s.url);
  await second.agent.loadSession({ sessionId, cwd, mcpServers: [] });
  assert.deepEqual(kinds(second.updates).slice(0, 2), ["user_message_chunk", "agent_message_chunk"], "the history is replayed: prompt, then answer");
  assert.equal((second.updates[1]!.update as { content: { text: string } }).content.text, "Hello");
  await second.agent.prompt({ sessionId, prompt: [{ type: "text", text: "hello again" }] });
  const bo = new Bo({ url: s.url });
  const [session] = await bo.sessions.list(await realpath(cwd));
  assert.equal(session!.runs, 2, "the loaded session continued, not a new one");

  const third = await connect(s.url);
  await third.agent.resumeSession({ sessionId: session!.id, cwd, mcpServers: [] });
  await third.agent.prompt({ sessionId: session!.id, prompt: [{ type: "text", text: "hello once more" }] });
  assert.equal((await bo.sessions.get(session!.id)).runs, 3, "a bo session id resumes too");
  await third.agent.closeSession({ sessionId: session!.id });
  await assert.rejects(third.agent.prompt({ sessionId: session!.id, prompt: [{ type: "text", text: "x" }] }), /no session/);
  await first.agent.deleteSession({ sessionId });
  assert.deepEqual(await bo.sessions.list(await realpath(cwd)), []);
});

test("_meta.bo carries bo's other knobs, validated; limits and failures end the turn clearly", async () => {
  const s = await boot();
  const editor = await connect(s.url);
  const cwd = await tmpdir();
  await assert.rejects(editor.agent.newSession({ cwd, mcpServers: [], _meta: { bo: { limits: { max_turns: 0 }, bogus: 1 } } }),
    (e: unknown) => /\/_meta\/bo\/bogus unknown field/.test(String((e as Error).message)) && /\/_meta\/bo\/limits\/max_turns must be an integer 1–10000/.test(String((e as Error).message)));
  const { sessionId } = await editor.agent.newSession({ cwd, mcpServers: [], _meta: { bo: { limits: { max_turns: 2 } } } });
  assert.equal((await editor.agent.prompt({ sessionId, prompt: [{ type: "text", text: "limit me" }] })).stopReason, "max_turn_requests");
  await assert.rejects(editor.agent.prompt({ sessionId, prompt: [{ type: "text", text: "fail now" }] }), /slow down \(rate_limited\)/);
});

test("editor input is checked where it arrives: MCP names that collide, values no option offers, oversized images", async () => {
  const s = await boot();
  const editor = await connect(s.url);
  const cwd = await tmpdir();
  const stdio = (name: string) => ({ name, command: "/bin/true", args: [], env: [] });
  await assert.rejects(editor.agent.newSession({ cwd, mcpServers: [stdio("a.b"), stdio("a/b")] }), /"a\.b" and "a\/b" are both named a_b/);
  const { sessionId } = await editor.agent.newSession({ cwd, mcpServers: [] });
  await assert.rejects(editor.agent.setSessionConfigOption({ sessionId, configId: "model", value: "claude-code/nope" }), /not one of the model options/);
  await assert.rejects(editor.agent.setSessionConfigOption({ sessionId, configId: "effort", value: "extreme" }), /not one of the effort options/);
  await assert.rejects(editor.agent.setSessionConfigOption({ sessionId, configId: "mode", value: "root" }), /not one of the mode options/);
  const huge = Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64");
  await assert.rejects(editor.agent.prompt({ sessionId, prompt: [{ type: "image", data: huge, mimeType: "image/png" }] }), /at most 5 MiB/);
});

test("prompt images exist while their run does and are removed when it ends", async () => {
  const s = await boot();
  const editor = await connect(s.url);
  const { sessionId } = await editor.agent.newSession({ cwd: await tmpdir(), mcpServers: [] });
  imagesSeen.length = 0;
  const png = Buffer.from("iVBORw0KGgo=", "base64").toString("base64");
  await editor.agent.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }, { type: "image", data: png, mimeType: "image/png" }] });
  assert.equal(imagesSeen.length, 1);
  assert.ok(imagesSeen[0]!.existed, "the engine could read it");
  assert.ok(!existsSync(imagesSeen[0]!.path), "gone once the turn ended");
});

test("deleting a session with a turn in progress ends the turn first; a bo id from another workspace is refused", async () => {
  const s = await boot();
  const editor = await connect(s.url);
  const cwd = await tmpdir();
  const { sessionId } = await editor.agent.newSession({ cwd, mcpServers: [] });
  const turn = editor.agent.prompt({ sessionId, prompt: [{ type: "text", text: "wait" }] });
  const bo = new Bo({ url: s.url });
  while (!(await bo.sessions.list(await realpath(cwd))).length) await new Promise((r) => setTimeout(r, 10));
  const [session] = await bo.sessions.list(await realpath(cwd));
  await editor.agent.deleteSession({ sessionId });
  assert.equal((await turn).stopReason, "cancelled");
  assert.deepEqual(await bo.sessions.list(await realpath(cwd)), [], "deleted, and it stays deleted");

  const other = await tmpdir();
  const { sessionId: kept } = await editor.agent.newSession({ cwd, mcpServers: [] });
  await editor.agent.prompt({ sessionId: kept, prompt: [{ type: "text", text: "hello" }] });
  const [mine] = await bo.sessions.list(await realpath(cwd));
  assert.notEqual(mine!.id, session!.id);
  await assert.rejects(editor.agent.resumeSession({ sessionId: mine!.id, cwd: other, mcpServers: [] }), /belongs to .*; open it there/);
});
