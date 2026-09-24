import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { classifyCodexAuth, CODEX_ARGS, codexModels, createCodex, prepareCodexHome, serverRequest } from "../src/harness/codex/index.ts";
import { createTranslator } from "../src/harness/codex/translate.ts";
import { CodexRpc } from "../src/harness/codex/rpc.ts";
import { spec, stubIo, tmpdir } from "./helpers.ts";

const FAKE = path.join(import.meta.dirname, "fake", "codex");

test("translator: items, deltas, usage, subagents, outcome", () => {
  const t = createTranslator({});
  t.setMainThread("th");
  const ops = [
    ["item/started", { threadId: "th", item: { type: "agentMessage", id: "m1", text: "" } }],
    ["item/agentMessage/delta", { threadId: "th", itemId: "m1", delta: "He" }],
    ["item/completed", { threadId: "th", item: { type: "agentMessage", id: "m1", text: "Hello" } }],
    ["item/started", { threadId: "th", item: { type: "commandExecution", id: "c1", command: "ls", status: "inProgress" } }],
    ["item/completed", { threadId: "th", item: { type: "commandExecution", id: "c1", command: "ls", status: "completed", exitCode: 0, aggregatedOutput: "a.txt\n" } }],
    ["item/completed", { threadId: "th", item: { type: "fileChange", id: "f1", status: "declined", changes: [{ path: "/x", kind: { type: "add" } }] } }],
    ["item/started", { threadId: "th", item: { type: "collabAgentToolCall", id: "col", prompt: "echo", receiverThreadIds: ["child"], status: "inProgress" } }],
    ["item/completed", { threadId: "child", item: { type: "agentMessage", id: "m2", text: "ECHO" } }],
    ["item/completed", { threadId: "th", item: { type: "reasoning", id: "r1", summary: ["think"] } }],
    ["thread/tokenUsage/updated", { threadId: "th", tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3 } } }],
    ["error", { threadId: "th", willRetry: true, error: { message: "retrying" } }],
    ["turn/completed", { threadId: "th", turn: { id: "tu", status: "completed" } }],
  ].flatMap(([method, params]) => t.onNotification(method as string, params));
  assert.deepEqual(ops[0], { op: "upsert", key: "m1", parentKey: undefined, body: { type: "message", role: "agent", content: [{ kind: "text", text: "" }], status: "in_progress" } });
  assert.deepEqual(ops[1], { op: "delta", key: "m1", text: "He" });
  assert.deepEqual(ops[3], { op: "upsert", key: "c1", parentKey: undefined, body: { type: "action", action: { kind: "shell", command: "ls" }, status: "running" } });
  assert.deepEqual(ops[4], { op: "upsert", key: "c1", parentKey: undefined, body: { type: "action", action: { kind: "shell", command: "ls" }, status: "completed", outcome: { exit_code: 0, excerpt: "a.txt" } } });
  assert.equal((ops[5] as { body: { status: string } }).body.status, "denied");
  assert.equal((ops[7] as { parentKey?: string }).parentKey, "col");
  assert.deepEqual((ops[8] as { body: unknown }).body, { type: "reasoning", text: "think" });
  assert.deepEqual(ops[9], { op: "call", tokens: 13, main: true }, "each model call is reported (input + output)");
  assert.equal((ops[10] as { body: { type: string } }).body.type, "notice");
  assert.deepEqual(t.onNotification("turn/plan/updated", { threadId: "th", plan: [{ step: "a", status: "inProgress" }, { step: "b", status: "pending" }] }), [
    { op: "upsert", key: "plan", body: { type: "plan", steps: [{ text: "a", status: "in_progress" }, { text: "b", status: "pending" }] } },
  ], "the plan tool maps onto the same plan item as Claude's");
  assert.deepEqual(t.onNotification("turn/plan/updated", { threadId: "child", plan: [{ step: "x", status: "pending" }] }), [], "a subagent's plan is not the run's");
  assert.deepEqual(t.onNotification("thread/tokenUsage/updated", {
    threadId: "child", tokenUsage: { total: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, last: { inputTokens: 7, cachedInputTokens: 2, outputTokens: 3 } },
  }), [{ op: "call", tokens: 10, main: false }], "every model call is reported, subagents' too");
  assert.deepEqual(t.outcome(), { ok: true, result: { kind: "text", text: "Hello" }, usage: { input_tokens: 17, output_tokens: 6, cached_input_tokens: 6 } },
    "this run: every call of every thread (main 10/3/4 + subagent 7/3/2); OpenAI input includes cached, output includes reasoning");
});

test("translator outcomes: schema, failures", () => {
  const s = createTranslator({ schema: { type: "object" } });
  s.setMainThread("th");
  s.onNotification("item/completed", { threadId: "th", item: { type: "agentMessage", id: "m", text: "{\"a\":1}" } });
  s.onNotification("turn/completed", { threadId: "th", turn: { id: "t", status: "completed" } });
  assert.deepEqual(s.outcome().ok && (s.outcome() as { result: unknown }).result, { kind: "data", data: { a: 1 } });
  const bad = createTranslator({ schema: { type: "object" } });
  bad.setMainThread("th");
  bad.onNotification("item/completed", { threadId: "th", item: { type: "agentMessage", id: "m", text: "nope" } });
  bad.onNotification("turn/completed", { threadId: "th", turn: { id: "t", status: "completed" } });
  assert.equal((bad.outcome() as { error: { code: string } }).error.code, "invalid_output");
  const auth = createTranslator({});
  auth.onNotification("turn/completed", { threadId: "", turn: { id: "t", status: "failed", error: { message: "401", codexErrorInfo: "unauthorized" } } });
  assert.deepEqual((auth.outcome() as { error: unknown }).error, { code: "auth_failed", message: "Codex authentication failed" });
  const rl = createTranslator({});
  rl.onNotification("turn/completed", { threadId: "", turn: { id: "t", status: "failed", error: { message: "slow down", codexErrorInfo: { rateLimitExceeded: {} } } } });
  assert.equal((rl.outcome() as { error: { code: string } }).error.code, "rate_limited");
  const ctx = createTranslator({});
  ctx.onNotification("turn/completed", { threadId: "", turn: { id: "t", status: "failed", error: { message: "too long", codexErrorInfo: "contextWindowExceeded" } } });
  assert.equal((ctx.outcome() as { error: { code: string } }).error.code, "context_exceeded");
});

test("server requests map onto awaiting items and native decisions", async () => {
  const t = createTranslator({});
  const interactive = spec({ engine: "codex", interactive: true });
  {
    const { io, awaited } = stubIo({ respond: () => ({ decision: "allow_for_run" }) });
    const r = await serverRequest("item/commandExecution/requestApproval", { itemId: "c1", threadId: "th", command: "rm x", reason: "outside" }, interactive, io, t);
    assert.deepEqual(r, { decision: "accept" }, "bo remembers allow_for_run; codex never gets a session-wide grant");
    assert.deepEqual(awaited[0]!.body, { type: "action", action: { kind: "shell", command: "rm x" }, status: "awaiting_approval", reason: "outside" });
  }
  {
    const { io } = stubIo({ respond: () => ({ decision: "deny" }) });
    assert.deepEqual(await serverRequest("item/fileChange/requestApproval", { itemId: "f", threadId: "th" }, interactive, io, t), { decision: "decline" });
  }
  for (const decision of ["allow", "allow_for_run"] as const) {
    const { io } = stubIo({ respond: () => ({ decision }) });
    assert.deepEqual(await serverRequest("item/permissions/requestApproval", { itemId: "p", threadId: "th", permissions: { network: {} } }, interactive, io, t),
      { permissions: { network: {} }, scope: "turn" });
  }
  {
    const { io } = stubIo({ respond: () => ({ answers: { q1: ["blue"] } }) });
    const r = await serverRequest("item/tool/requestUserInput", { itemId: "u", threadId: "th", questions: [{ id: "q1", header: "h", question: "Color?", options: [{ label: "blue", description: "" }] }] }, interactive, io, t);
    assert.deepEqual(r, { answers: { q1: { answers: ["blue"] } } });
  }
  {
    const { io, awaited, allowedForRun } = stubIo();
    allowedForRun.add("shell");
    assert.deepEqual(await serverRequest("item/commandExecution/requestApproval", { itemId: "c", threadId: "th", command: "x" }, interactive, io, t), { decision: "accept" });
    assert.equal(awaited.length, 0);
    assert.deepEqual(await serverRequest("item/commandExecution/requestApproval", { itemId: "c", threadId: "th", command: "x" }, spec({ access: "read" }), stubIo().io, t), { decision: "decline" });
  }
  assert.deepEqual(await serverRequest("mcpServer/elicitation/request", {}, interactive, stubIo().io, t), { action: "decline" });
  await assert.rejects(serverRequest("item/tool/call", {}, interactive, stubIo().io, t));
});

test("classifyCodexAuth", () => {
  assert.equal(classifyCodexAuth({ account: { type: "apiKey" }, requiresOpenaiAuth: true }), "api_key");
  assert.equal(classifyCodexAuth({ account: { type: "amazonBedrock" }, requiresOpenaiAuth: false }), "cloud_provider");
  assert.equal(classifyCodexAuth({ account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true }), "subscription");
  assert.equal(classifyCodexAuth({ account: null, requiresOpenaiAuth: true }), "none");
});

test("RPC rejects pending requests when the child exits", async () => {
  const rpc = new CodexRpc("/bin/false", [], process.cwd(), process.env);
  await assert.rejects(rpc.request("never", {}, 1_000), /exited|closed|EPIPE/);
  await rpc.close();
});

test("codexModels: canonical ids, aliases, efforts; hidden models skipped", () => {
  assert.deepEqual(codexModels([
    { id: "gpt-x-preset", model: "gpt-x", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }, { reasoningEffort: "xhigh", description: "" }] },
    { id: "gpt-y", model: "gpt-y", isDefault: false, inputModalities: ["text"] },
    { id: "gpt-hidden", model: "gpt-hidden", isDefault: false, hidden: true },
  ]), [
    { id: "gpt-x", aliases: ["gpt-x-preset"], default: true, efforts: ["low", "xhigh"], images: true },
    { id: "gpt-y", aliases: [], default: false, efforts: [], images: false },
  ]);
});

test("prepareCodexHome: bo's own home, auth shared by symlink, removed when the operator has none", async () => {
  const state = await tmpdir();
  const operator = await tmpdir();
  const env = { XDG_STATE_HOME: state, CODEX_HOME: operator, HOME: operator };
  await mkdir(path.join(state, "bo", "codex"), { recursive: true });
  await writeFile(path.join(state, "bo", "codex", "config.toml"), '[projects."/repo"]\ntrust_level = "trusted"\n');
  const home = await prepareCodexHome(env);
  assert.equal(home, path.join(state, "bo", "codex"));
  await assert.rejects(lstat(path.join(home, "config.toml")), "config codex persisted (project trust) is removed");
  await assert.rejects(lstat(path.join(home, "auth.json")), "no operator login, no link");
  await writeFile(path.join(operator, "auth.json"), "{}");
  await writeFile(path.join(operator, "config.toml"), "[mcp_servers.leak]\ncommand = \"x\"\n");
  await prepareCodexHome(env);
  assert.equal(await readlink(path.join(home, "auth.json")), path.join(operator, "auth.json"));
  await assert.rejects(lstat(path.join(home, "config.toml")), "the operator config never reaches bo's home");
  const other = await tmpdir();
  await writeFile(path.join(other, "auth.json"), "{}");
  await prepareCodexHome({ ...env, CODEX_HOME: other });
  assert.equal(await readlink(path.join(home, "auth.json")), path.join(other, "auth.json"), "re-pointed");
  await prepareCodexHome({ ...env, CODEX_HOME: await tmpdir() });
  await assert.rejects(lstat(path.join(home, "auth.json")), "removed");
});

async function fakeEnv(steps: unknown[]) {
  const dir = await tmpdir();
  const script = path.join(dir, "script.json");
  const log = path.join(dir, "log.jsonl");
  const state = path.join(dir, "state");
  await mkdir(state);
  await writeFile(script, JSON.stringify(steps));
  return { env: { ...process.env, FAKE_SCRIPT: script, FAKE_LOG: log, XDG_STATE_HOME: state, BO_TOKEN: "secret-token" }, log, state };
}

async function logged(log: string) {
  return (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { env?: Record<string, string | null>; argv?: string[]; method?: string; params?: Record<string, unknown>; result?: unknown });
}

const HANDSHAKE = [
  { on: "initialize", result: { userAgent: "fake" } },
];

test("run: full turn with an approval through the fake app-server", async () => {
  const root = await tmpdir();
  const { env, log } = await fakeEnv([
    ...HANDSHAKE,
    { on: "account/read", result: { account: { type: "apiKey" }, requiresOpenaiAuth: true } },
    { on: "thread/start", result: { thread: { id: "th-1" }, model: "gpt-x" } },
    { on: "turn/start", result: { turn: { id: "tu-1" } } },
    { send: { method: "item/started", params: { threadId: "th-1", turnId: "tu-1", item: { type: "commandExecution", id: "c1", command: "touch b", status: "inProgress" } } } },
    { ask: { method: "item/commandExecution/requestApproval", params: { itemId: "c1", threadId: "th-1", turnId: "tu-1", command: "touch b" } } },
    { send: { method: "item/completed", params: { threadId: "th-1", turnId: "tu-1", item: { type: "commandExecution", id: "c1", command: "touch b", status: "completed", exitCode: 0 } } } },
    { send: { method: "item/completed", params: { threadId: "th-1", turnId: "tu-1", item: { type: "agentMessage", id: "m", text: "done" } } } },
    { send: { method: "turn/completed", params: { threadId: "th-1", turn: { id: "tu-1", status: "completed" } } } },
  ]);
  const h = createCodex({ command: FAKE, env });
  const { io, state, awaited } = stubIo({ respond: () => ({ decision: "allow" }) });
  const out = await h.run(spec({
    engine: "codex", root, access: "read", interactive: true, internet: false, env: { SPEC_VAR: "1" },
    subagents: { helper: { description: "d", instructions: "i", effort: "high" } },
  }), io);
  const [first] = await logged(log);
  assert.equal(first!.env!.BO_TOKEN, null, "bo's own configuration never reaches the engine");
  assert.equal(first!.env!.SPEC_VAR, "1", "the run's env reaches the engine");
  assert.deepEqual(first!.argv, CODEX_ARGS, "operator-account features are off at launch");
  assert.equal(first!.env!.CODEX_HOME, path.join(env.XDG_STATE_HOME, "bo", "codex"));
  assert.deepEqual(out.ok && out.result, { kind: "text", text: "done" });
  assert.equal(state.session, "th-1");
  assert.equal(state.model, "gpt-x");
  assert.equal(awaited.length, 1);
  const sent = await logged(log);
  const thread = sent.find((x) => x.method === "thread/start")!.params! as { config: { agents: { helper: { config_file: string } } } };
  const { agents, ...config } = thread.config;
  assert.deepEqual({ ...thread, config }, {
    cwd: root, sandbox: "read-only", approvalPolicy: "on-request",
    config: { projects: { [root]: { trust_level: "untrusted" } }, web_search: "disabled", tools: { update_plan: { enabled: true } }, model_reasoning_summary: "auto" },
  }, "the workspace is untrusted: no project .codex/ layer, no AGENTS.md, nothing persisted");
  assert.equal(await readFile(agents.helper.config_file, "utf8"), 'developer_instructions = "i"\nmodel_reasoning_effort = "high"\n');
  const turn = sent.find((x) => x.method === "turn/start")!.params!;
  assert.deepEqual(turn.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.ok(sent.some((x) => (x.result as { decision?: string } | undefined)?.decision === "accept"));
});

test("run: subscription auth is refused before thread/start", async () => {
  const { env, log } = await fakeEnv([
    ...HANDSHAKE,
    { on: "account/read", result: { account: { type: "chatgpt", email: null, planType: "pro" }, requiresOpenaiAuth: true } },
  ]);
  const h = createCodex({ command: FAKE, env: { ...env, BO_ALLOW_SUBSCRIPTION_AUTH: "" } });
  const out = await h.run(spec({ engine: "codex", root: await tmpdir() }), stubIo().io);
  assert.ok(!out.ok && out.error.code === "auth_failed");
  const sent = await readFile(log, "utf8");
  assert.ok(!sent.includes("thread/start"));
});

test("run: a turn that completes in the same chunk as the turn/start response is not missed", async () => {
  const { env } = await fakeEnv([
    ...HANDSHAKE,
    { on: "account/read", result: { account: { type: "apiKey" }, requiresOpenaiAuth: true } },
    { on: "thread/start", result: { thread: { id: "th-1" }, model: "gpt-x" } },
    { on: "turn/start", result: { turn: { id: "tu-1" } }, then: [
      { method: "item/completed", params: { threadId: "th-1", turnId: "tu-1", item: { type: "agentMessage", id: "m", text: "fast" } } },
      { method: "turn/completed", params: { threadId: "th-1", turn: { id: "tu-1", status: "completed" } } },
    ] },
  ]);
  const started = Date.now();
  const out = await createCodex({ command: FAKE, env }).run(spec({ engine: "codex", root: await tmpdir() }), stubIo().io);
  assert.deepEqual(out.ok && out.result, { kind: "text", text: "fast" });
  assert.ok(Date.now() - started < 5_000);
});

test("RPC: a late answer to a timed-out request is dropped; the channel stays usable", async () => {
  const { env } = await fakeEnv([{ on: "slow", delay: 150 }, { on: "fast", result: { ok: true } }]);
  const rpc = new CodexRpc(FAKE, [], process.cwd(), env);
  await assert.rejects(rpc.request("slow", {}, 30), /timed out/);
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(await rpc.request("fast", {}), { ok: true });
  await rpc.close();
});

test("translator: neutral actions, notices, final answer, error codes", () => {
  const t = createTranslator({});
  t.setMainThread("th");
  const item = (x: Record<string, unknown>) => t.onNotification("item/completed", { threadId: "th", item: x });
  const body = (ops: ReturnType<typeof item>) => (ops[0] as { body: { action?: unknown; text?: string } }).body;
  assert.deepEqual(body(item({ type: "commandExecution", id: "r", command: "cat a b", status: "completed", commandActions: [
    { type: "read", command: "cat a", name: "a", path: "/w/a" }, { type: "read", command: "cat b", name: "b", path: "/w/b" },
  ] })).action, { kind: "read", paths: ["/w/a", "/w/b"] });
  assert.deepEqual(body(item({ type: "commandExecution", id: "s", command: "rg foo", status: "completed", commandActions: [{ type: "search", command: "rg foo", query: "foo" }] })).action,
    { kind: "search", query: "foo" });
  assert.deepEqual(body(item({ type: "commandExecution", id: "x", command: "make", status: "completed", commandActions: [{ type: "unknown", command: "make" }] })).action,
    { kind: "shell", command: "make" });
  assert.deepEqual(body(item({ type: "webSearch", id: "w", query: "", action: { type: "openPage", url: "https://x.test" } })).action, { kind: "web", url: "https://x.test" });
  assert.deepEqual(body(item({ type: "imageView", id: "i", path: "/w/p.png" })).action, { kind: "read", paths: ["/w/p.png"] });
  assert.equal(body(item({ type: "contextCompaction", id: "c" })).text, "context compacted");
  assert.equal(body(t.onNotification("mcpServer/startupStatus/updated", { name: "gh", status: "failed", error: "boom" })).text, "MCP server gh failed to start: boom");
  assert.deepEqual(t.onNotification("mcpServer/startupStatus/updated", { name: "gh", status: "ready" }), []);
  item({ type: "agentMessage", id: "f", text: "the answer", phase: "final_answer" });
  item({ type: "agentMessage", id: "g", text: "a trailing remark", phase: "commentary" });
  t.onNotification("turn/completed", { threadId: "th", turn: { id: "t", status: "completed" } });
  assert.deepEqual(t.outcome().ok && t.outcome().ok && (t.outcome() as { result: unknown }).result, { kind: "text", text: "the answer" });
  const overloaded = createTranslator({});
  overloaded.onNotification("turn/completed", { threadId: "", turn: { id: "t", status: "failed", error: { message: "busy", codexErrorInfo: "serverOverloaded" } } });
  assert.equal((overloaded.outcome() as { error: { code: string } }).error.code, "rate_limited");
});

test("file changes carry hunks: updates as sent, a new file's content and a deleted file's as whole hunks", () => {
  const t = createTranslator({});
  t.setMainThread("th");
  const [op] = t.onNotification("item/completed", { threadId: "th", item: { type: "fileChange", id: "f", status: "completed", changes: [
    { path: "/w/a.txt", kind: { type: "update", move_path: null }, diff: "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n" },
    { path: "/w/b.txt", kind: { type: "add" }, diff: "hi\n" },
    { path: "/w/c.txt", kind: { type: "delete" }, diff: "gone\n" },
  ] } });
  assert.deepEqual((op as { body: { action: unknown } }).body.action, { kind: "edit", changes: [
    { path: "/w/a.txt", change: "modify", diff: "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n" },
    { path: "/w/b.txt", change: "add", diff: "@@ -0,0 +1,1 @@\n+hi\n" },
    { path: "/w/c.txt", change: "delete", diff: "@@ -1,1 +0,0 @@\n-gone\n" },
  ] });
});
