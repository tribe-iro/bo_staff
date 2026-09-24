import { test } from "node:test";
import assert from "node:assert/strict";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { classifyClaudeAuth, claudeModels, createClaudeCode, policyFor } from "../src/harness/claude-code/index.ts";
import { createTranslator, toAction } from "../src/harness/claude-code/translate.ts";
import { fakeQuery, spec, steer, stubIo } from "./helpers.ts";

const m = (x: unknown) => x as SDKMessage;
const init = m({ type: "system", subtype: "init", session_id: "s-1", model: "claude-x", apiKeySource: "ANTHROPIC_API_KEY" });
const result = (over: Record<string, unknown> = {}) => m({
  type: "result", subtype: "success", is_error: false, result: "final", session_id: "s-1", total_cost_usd: 0.5,
  modelUsage: { a: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 1 } }, ...over,
});

test("toAction maps built-in tools onto the neutral vocabulary", () => {
  assert.deepEqual(toAction("Bash", { command: "ls" }), { kind: "shell", command: "ls" });
  assert.deepEqual(toAction("Write", { file_path: "/a" }), { kind: "edit", changes: [{ path: "/a", change: "add" }] });
  assert.deepEqual(toAction("Grep", { pattern: "x" }), { kind: "search", query: "x" });
  assert.deepEqual(toAction("WebSearch", { query: "q" }), { kind: "web", query: "q" });
  assert.deepEqual(toAction("Agent", { subagent_type: "echo", description: "d" }), { kind: "delegate", subagent: "echo", task: "d" });
  assert.deepEqual(toAction("mcp__fx__do_it", {}), { kind: "mcp", server: "fx", tool: "do_it" });
  assert.deepEqual(toAction("Mystery", {}), { kind: "other", name: "Mystery" });
});

test("translator: session, streaming message, tool lifecycle, plan, reasoning, result", () => {
  const t = createTranslator({});
  const ops = [
    init,
    m({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg1" } } }),
    m({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text" } } }),
    m({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } } }),
    m({ type: "assistant", parent_tool_use_id: null, message: { id: "msg1", content: [{ type: "text", text: "Hello" }] } }),
    m({ type: "assistant", parent_tool_use_id: null, message: { id: "msg1", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] } }),
    m({ type: "assistant", parent_tool_use_id: null, message: { id: "msg2", content: [{ type: "thinking", thinking: "hmm" }, { type: "tool_use", id: "tu2", name: "TodoWrite", input: { todos: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }] } }] } }),
    m({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "file.txt", is_error: false }] } }),
    m({ type: "assistant", parent_tool_use_id: "tu9", message: { id: "msg3", content: [{ type: "text", text: "from subagent" }] } }),
    result(),
  ].flatMap((x) => t.onMessage(x));
  assert.deepEqual(ops[0], { op: "session", native: "s-1" });
  assert.deepEqual(ops[1], { op: "model", id: "claude-x" });
  assert.deepEqual(ops[2], { op: "upsert", key: "msg1:0", body: { type: "message", role: "agent", content: [{ kind: "text", text: "" }], status: "in_progress" } });
  assert.deepEqual(ops[3], { op: "delta", key: "msg1:0", text: "Hel" });
  assert.deepEqual(ops[4], { op: "upsert", key: "msg1:0", body: { type: "message", role: "agent", content: [{ kind: "text", text: "Hello" }], status: "completed" }, parentKey: undefined });
  assert.deepEqual(ops[5], { op: "upsert", key: "tu1", body: { type: "action", action: { kind: "shell", command: "ls" }, status: "running" }, parentKey: undefined });
  assert.deepEqual(ops[6], { op: "upsert", key: "msg2:0", body: { type: "reasoning", text: "hmm" }, parentKey: undefined });
  assert.deepEqual(ops[7], { op: "upsert", key: "plan", body: { type: "plan", steps: [{ text: "a", status: "completed" }, { text: "b", status: "in_progress" }] } });
  assert.deepEqual(ops[8], { op: "upsert", key: "tu1", body: { type: "action", action: { kind: "shell", command: "ls" }, status: "completed", outcome: { excerpt: "file.txt" } }, parentKey: undefined });
  assert.deepEqual(ops[9], { op: "upsert", key: "msg3:0", body: { type: "message", role: "agent", content: [{ kind: "text", text: "from subagent" }], status: "completed" }, parentKey: "tu9" });
  const totals = { input_tokens: 13, output_tokens: 5, cached_input_tokens: 2, cost_usd: 0.5 };
  assert.deepEqual(t.outcome(), { ok: true, result: { kind: "text", text: "final" }, usage: totals, totals },
    "input counts cache reads and writes; cached counts reads only");
});

test("translator: a whitespace-only streamed block never opens an item", () => {
  const t = createTranslator({});
  const ev = (event: unknown) => m({ type: "stream_event", parent_tool_use_id: null, event });
  const ops = [
    ev({ type: "message_start", message: { id: "w" } }),
    ev({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "\n" } }),
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "  " } }),
    m({ type: "assistant", parent_tool_use_id: null, message: { id: "w", content: [{ type: "text", text: "\n  " }] } }),
    ev({ type: "content_block_start", index: 1, content_block: { type: "text" } }),
    ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: " " } }),
    ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi" } }),
    ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "!" } }),
  ].flatMap((x) => t.onMessage(x));
  assert.deepEqual(ops, [
    { op: "upsert", key: "w:1", body: { type: "message", role: "agent", content: [{ kind: "text", text: "" }], status: "in_progress" } },
    { op: "delta", key: "w:1", text: " Hi" },
    { op: "delta", key: "w:1", text: "!" },
  ]);
});

test("claudeModels collapses aliases onto wire ids and keeps efforts", () => {
  assert.deepEqual(claudeModels([
    { value: "default", resolvedModel: "claude-a", displayName: "", description: "", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
    { value: "opus", resolvedModel: "claude-a", displayName: "", description: "", supportsEffort: true, supportedEffortLevels: ["high", "max"] },
    { value: "haiku", resolvedModel: "claude-h", displayName: "", description: "", supportsEffort: false, supportedEffortLevels: ["low"] },
    { value: "claude-z", displayName: "", description: "" },
  ]), [
    { id: "claude-a", aliases: ["default", "opus"], default: true, efforts: ["low", "high", "max"], images: true },
    { id: "claude-h", aliases: ["haiku"], default: false, efforts: [], images: true },
    { id: "claude-z", aliases: [], default: false, efforts: [], images: true },
  ]);
});

test("translator folds TaskCreate/TaskUpdate into one plan item", () => {
  const t = createTranslator({});
  const ops = [
    m({ type: "assistant", parent_tool_use_id: null, message: { id: "a", content: [{ type: "tool_use", id: "c1", name: "TaskCreate", input: { subject: "one", description: "d" } }] } }),
    m({ type: "user", parent_tool_use_id: null, tool_use_result: { task: { id: "1", subject: "one" } }, message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "Task #1 created" }] } }),
    m({ type: "assistant", parent_tool_use_id: null, message: { id: "b", content: [{ type: "tool_use", id: "c2", name: "TaskCreate", input: { subject: "two", description: "d" } }] } }),
    m({ type: "user", parent_tool_use_id: null, tool_use_result: { task: { id: "2", subject: "two" } }, message: { content: [{ type: "tool_result", tool_use_id: "c2", content: "Task #2 created" }] } }),
    m({ type: "assistant", parent_tool_use_id: null, message: { id: "c", content: [{ type: "tool_use", id: "u1", name: "TaskUpdate", input: { taskId: "1", status: "completed" } }] } }),
    m({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "u1", content: "ok" }] } }),
  ].flatMap((x) => t.onMessage(x));
  assert.ok(ops.every((o) => o.op === "upsert" && o.key === "plan"));
  assert.deepEqual((ops.at(-1) as { body: unknown }).body, { type: "plan", steps: [{ text: "one", status: "completed" }, { text: "two", status: "pending" }] });
});

test("translator outcomes: structured output, invalid output, errors", () => {
  const s = createTranslator({ schema: { type: "object" } });
  s.onMessage(result({ structured_output: { answer: "x" } }));
  assert.deepEqual(s.outcome().ok && s.outcome(), { ok: true, result: { kind: "data", data: { answer: "x" } }, usage: s.outcome().usage, totals: s.outcome().totals });
  const bad = createTranslator({ schema: { type: "object" } });
  bad.onMessage(result({ structured_output: "nope" }));
  assert.equal(!bad.outcome().ok && (bad.outcome() as { error: { code: string } }).error.code, "invalid_output");
  const auth = createTranslator({});
  auth.onMessage(m({ type: "assistant", error: "authentication_failed", parent_tool_use_id: null, message: { id: "e", content: [] } }));
  auth.onMessage(result({ subtype: "success", is_error: true, result: "Not logged in" }));
  assert.deepEqual((auth.outcome() as { error: unknown }).error, { code: "auth_failed", message: "Claude authentication failed" });
  const ctx = createTranslator({});
  ctx.onMessage(result({ subtype: "error_during_execution", is_error: true, result: undefined, terminal_reason: "prompt_too_long" }));
  assert.equal((ctx.outcome() as { error: { code: string } }).error.code, "context_exceeded");
  assert.equal((createTranslator({}).outcome() as { error: { message: string } }).error.message, "Claude execution failed");
});

test("policy rules, in order", async () => {
  const opts = { signal: new AbortController().signal, toolUseID: "t1", requestId: "r", decisionReason: "why" } as never;
  // 1: questions without a user
  {
    const { io } = stubIo();
    const p = policyFor(spec({ interactive: false }), io, { denied: new Set() });
    assert.deepEqual(await p("AskUserQuestion", { questions: [] }, opts), { behavior: "deny", message: "No user is available. Proceed with your best judgment." });
  }
  // 1: questions answered
  {
    const { io, awaited } = stubIo({ respond: () => ({ answers: { "0": ["blue"] } }) });
    const p = policyFor(spec({ interactive: true }), io, { denied: new Set() });
    const input = { questions: [{ question: "Color?", header: "c", options: [{ label: "red" }, { label: "blue" }], multiSelect: false }] };
    const r = await p("AskUserQuestion", input, opts);
    assert.equal(awaited[0]!.body.type, "question");
    assert.deepEqual(r, { behavior: "allow", updatedInput: { ...input, answers: { "Color?": "blue" } } });
  }
  // 2: caller MCP allowlist
  {
    const { io, upserts } = stubIo();
    const denied = new Set<string>();
    const p = policyFor(spec({ mcp: { fx: { command: "x", tools: ["ok"] } } }), io, { denied });
    assert.equal((await p("mcp__fx__ok", {}, opts))!.behavior, "allow");
    assert.deepEqual(await p("mcp__fx__no", {}, opts), { behavior: "deny", message: "tool not permitted" });
    assert.ok(denied.has("t1") && upserts.at(-1)!.body.type === "action");
  }
  // 3: full access
  {
    const { io } = stubIo();
    assert.equal((await policyFor(spec({ access: "full" }), io, { denied: new Set() })("Bash", { command: "x" }, opts))!.behavior, "allow");
  }
  // 4: allowed for run
  {
    const { io, allowedForRun } = stubIo();
    allowedForRun.add("shell");
    assert.equal((await policyFor(spec({ access: "read" }), io, { denied: new Set() })("Bash", { command: "x" }, opts))!.behavior, "allow");
  }
  // 4b: sandboxed Bash is confined by the OS sandbox; escaping it falls through
  {
    const { io } = stubIo();
    const p = policyFor(spec({ access: "write" }), io, { denied: new Set() });
    assert.equal((await p("Bash", { command: "for i in $(seq 3); do echo $i; done" }, opts))!.behavior, "allow");
    assert.equal((await p("Bash", { command: "touch ../x", dangerouslyDisableSandbox: true }, opts))!.behavior, "deny");
  }
  // 4c: web tools are allowed when internet is on (they are removed entirely when it is off)
  {
    const { io } = stubIo();
    const on = policyFor(spec({ access: "write", internet: true, interactive: false }), io, { denied: new Set() });
    assert.equal((await on("WebFetch", { url: "https://example.com" }, opts))!.behavior, "allow");
    assert.equal((await on("WebSearch", { query: "q" }, opts))!.behavior, "allow");
    const off = policyFor(spec({ access: "write", internet: false, interactive: false }), io, { denied: new Set() });
    assert.equal((await off("WebFetch", { url: "https://example.com" }, opts))!.behavior, "deny");
  }
  // 5: not interactive → denied with reason
  {
    const { io, upserts } = stubIo();
    const r = await policyFor(spec({ access: "read" }), io, { denied: new Set() })("Write", { file_path: "/x" }, opts);
    assert.deepEqual(r, { behavior: "deny", message: "not permitted by access level read" });
    assert.ok(upserts.at(-1)!.body.type === "action" && (upserts.at(-1)!.body as { status: string }).status === "denied");
  }
  // 6: ask the caller
  {
    const { io, awaited } = stubIo({ respond: () => ({ decision: "deny" }) });
    const r = await policyFor(spec({ access: "read", interactive: true }), io, { denied: new Set() })("Bash", { command: "rm -rf x", dangerouslyDisableSandbox: true }, opts);
    assert.deepEqual(awaited[0]!.body, { type: "action", action: { kind: "shell", command: "rm -rf x" }, status: "awaiting_approval", reason: "why" });
    assert.deepEqual(r, { behavior: "deny", message: "denied by caller" });
  }
});

test("classifyClaudeAuth", () => {
  assert.equal(classifyClaudeAuth({ CLAUDE_CODE_USE_BEDROCK: "1" }, {}), "cloud_provider");
  assert.equal(classifyClaudeAuth({ ANTHROPIC_API_KEY: "k" }, { subscriptionType: "max" }), "api_key");
  assert.equal(classifyClaudeAuth({}, { apiProvider: "vertex" }), "cloud_provider");
  assert.equal(classifyClaudeAuth({}, { subscriptionType: "max", apiKeySource: "none" }), "subscription");
  assert.equal(classifyClaudeAuth({}, { apiKeySource: "/login managed key" }), "api_key");
  assert.equal(classifyClaudeAuth({}, { apiKeySource: "none" }), "none");
});

test("run: options, prompt, items, and outcome through a fake query", async () => {
  const q = fakeQuery({
    messages: [init, m({ type: "assistant", parent_tool_use_id: null, message: { id: "a", content: [{ type: "text", text: "hi" }] } }), result()],
  });
  const h = createClaudeCode({ query: q.fn, claudePath: "/bin/claude", env: { ANTHROPIC_API_KEY: "k", PATH: "/usr/bin", BO_TOKEN: "secret", BO_MAX_RUNS: "3" } });
  const { io, upserts, state } = stubIo();
  const out = await h.run(spec({
    access: "read", instructions: "be brief", schema: undefined, internet: false,
    env: { SPEC_VAR: "1", PATH: "/opt/bin" }, limits: { maxTurns: 7, maxTokens: 1000 },
    subagents: { helper: { description: "d", instructions: "i", effort: "high" } },
  }), io);
  assert.equal(out.ok, true);
  assert.equal(state.session, "s-1");
  assert.ok(upserts.some((u) => u.body.type === "message"));
  const o = q.calls.options!;
  assert.equal(o.permissionMode, "default");
  assert.deepEqual(o.allowedTools, ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);
  assert.deepEqual(o.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(o.systemPrompt, { type: "preset", preset: "claude_code", append: "be brief" });
  assert.deepEqual(o.disallowedTools, ["WebFetch", "WebSearch"]);
  assert.equal(o.sandbox?.enabled, true);
  assert.deepEqual(o.sandbox?.network, { allowedDomains: [], strictAllowlist: true });
  assert.equal(q.calls.prompts[0]!.message.content, "hi");
  assert.deepEqual(o.settingSources, [], "operator settings are never loaded");
  assert.equal(o.env?.BO_TOKEN, undefined, "bo's own configuration never reaches the engine");
  assert.equal(o.env?.BO_MAX_RUNS, undefined);
  assert.equal(o.env?.PATH, "/opt/bin", "the run's env overrides the server's");
  assert.equal(o.env?.SPEC_VAR, "1");
  assert.equal(o.env?.ANTHROPIC_API_KEY, "k");
  assert.equal(o.strictMcpConfig, true, "only the spec's MCP servers (no claude.ai connectors)");
  assert.deepEqual(o.settings, { disableBundledSkills: true, autoMemoryEnabled: false }, "no bundled skills, no auto-memory");
  assert.equal(o.maxTurns, undefined, "limits are bo's, enforced the same way for every engine");
  assert.equal(o.maxBudgetUsd, undefined);
  assert.deepEqual(o.agents, { helper: { description: "d", prompt: "i", effort: "high" } });
});

test("probe reports canonical models with aliases and efforts", async () => {
  const q = fakeQuery({ messages: [] });
  const probed = await createClaudeCode({ query: q.fn, claudePath: "/bin/true", env: { ANTHROPIC_API_KEY: "k", PATH: "" } }).probe();
  assert.equal(probed.available, true);
  assert.deepEqual(probed.models, [
    { id: "claude-x-1", aliases: ["default", "opus"], default: true, efforts: ["low", "high", "max"], images: true },
    { id: "claude-h-1", aliases: ["haiku"], default: false, efforts: [], images: true },
  ]);
  assert.deepEqual(q.calls.options?.settingSources, []);
});

test("run: a steer that cannot be read is dropped, never an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const q = fakeQuery({ messages: [init, result()] });
    const h = createClaudeCode({ query: q.fn, claudePath: "/bin/claude", env: { ANTHROPIC_API_KEY: "k", PATH: "" } });
    const { io, messages } = stubIo();
    const gone = steer([{ kind: "image", path: "/nonexistent/bo-test.png", media_type: "image/png" }]);
    messages.push(gone);
    const out = await h.run(spec(), io);
    assert.equal(out.ok, true);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(gone.settled && "dropped" in gone.settled, JSON.stringify(gone.settled));
    messages.close();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test("run: subscription auth is refused before any prompt is sent", async () => {
  const q = fakeQuery({ messages: [init, result()], account: { subscriptionType: "max", apiKeySource: "none" } });
  const h = createClaudeCode({ query: q.fn, claudePath: "/bin/claude", env: { PATH: "" } });
  const { io } = stubIo();
  const out = await h.run(spec(), io);
  assert.ok(!out.ok && out.error.code === "auth_failed" && out.error.message.includes("subscription"));
  assert.equal(q.calls.prompts.length, 0);
});

test("translator: background tasks keep the session busy; their completion updates the delegate action", () => {
  const t = createTranslator({});
  t.onMessage(m({ type: "assistant", parent_tool_use_id: null, message: { id: "a", content: [{ type: "tool_use", id: "tu", name: "Agent", input: { subagent_type: "echoer", description: "echo" } }] } }));
  t.onMessage(m({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "sh", task_type: "local_bash", description: "sleep" }] }));
  assert.equal(t.busy, false, "a background shell ends with the run");
  t.onMessage(m({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "t1", task_type: "local_agent", description: "echo" }, { task_id: "w", task_type: "watch", description: "", ambient: true }] }));
  assert.equal(t.busy, true);
  const done = t.onMessage(m({ type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "tu", status: "completed", output_file: "", summary: "ECHO" }));
  assert.deepEqual(done, [{ op: "upsert", key: "tu", body: { type: "action", action: { kind: "delegate", subagent: "echoer", task: "echo" }, status: "completed", outcome: { excerpt: "ECHO" } } }]);
  t.onMessage(m({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "w", task_type: "watch", description: "", ambient: true }] }));
  assert.equal(t.busy, false, "ambient tasks are not work");
});

test("translator: compaction and MCP start-up failures become notices", () => {
  const t = createTranslator({});
  const ops = [
    m({ ...init, mcp_servers: [{ name: "gh", status: "failed" }, { name: "ok", status: "connected" }] }),
    m({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 1 } }),
  ].flatMap((x) => t.onMessage(x)).filter((o) => o.op === "upsert");
  assert.deepEqual(ops.map((o) => o.op === "upsert" && o.body), [
    { type: "notice", level: "warning", text: "MCP server gh failed to start" },
    { type: "notice", level: "info", text: "context compacted" },
  ]);
});

test("translator: engine failures map onto the error taxonomy", () => {
  const code = (msgs: SDKMessage[]) => {
    const t = createTranslator({});
    for (const x of msgs) t.onMessage(x);
    const o = t.outcome();
    return o.ok ? "ok" : o.error.code;
  };
  const failed = (over: Record<string, unknown>) => result({ is_error: true, ...over });
  const said = (error: string) => m({ type: "assistant", parent_tool_use_id: null, error, message: { id: "e", content: [] } });
  assert.equal(code([said("cloud_credential_error"), failed({})]), "auth_failed");
  assert.equal(code([said("billing_error"), failed({})]), "auth_failed");
  assert.equal(code([said("overloaded"), failed({})]), "rate_limited");
  assert.equal(code([failed({ subtype: "error_max_turns" })]), "limit_exceeded");
  assert.equal(code([failed({ subtype: "error_max_budget_usd" })]), "limit_exceeded");
  assert.equal(code([failed({ subtype: "error_max_structured_output_retries" })]), "invalid_output");
  assert.equal(code([failed({ terminal_reason: "prompt_too_long" })]), "context_exceeded");
  assert.equal(code([failed({ terminal_reason: "model_error" })]), "engine_error");
});

test("run: a classified terminal result wins over the CLI's non-zero exit (turn limit)", async () => {
  const q = fakeQuery({ messages: [init, result({ subtype: "error_max_turns", is_error: true, terminal_reason: "max_turns" })] });
  const failing = ((params: Parameters<typeof q.fn>[0]) => {
    const inner = q.fn(params);
    const gen = (async function* () { yield* inner; throw new Error("Claude Code process exited with code 1"); })();
    return Object.assign(gen, { accountInfo: inner.accountInfo, interrupt: inner.interrupt, close: inner.close });
  }) as unknown as typeof q.fn;
  const out = await createClaudeCode({ query: failing, claudePath: "/bin/claude", env: { ANTHROPIC_API_KEY: "k", PATH: "" } }).run(spec(), stubIo().io);
  assert.ok(!out.ok && out.error.code === "limit_exceeded", JSON.stringify(out));
});

test("translator: every model call is reported with its tokens (cache included); subagent calls are not main", () => {
  const t = createTranslator({});
  const ev = (event: Record<string, unknown>, parent: string | null = null) => t.onMessage(m({ type: "stream_event", parent_tool_use_id: parent, event }));
  ev({ type: "message_start", message: { id: "a", usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } });
  ev({ type: "message_start", message: { id: "s", usage: { input_tokens: 7 } } }, "tu1");
  assert.deepEqual(ev({ type: "message_delta", usage: { output_tokens: 3 } }, "tu1"), [{ op: "call", tokens: 10, main: false }]);
  assert.deepEqual(ev({ type: "message_delta", usage: { output_tokens: 40 } }), [{ op: "call", tokens: 165, main: true }]);
  assert.deepEqual(ev({ type: "message_delta", usage: { output_tokens: 1 } }), [], "one report per call");
});

test("per-run usage: a resumed session's running totals minus the baseline; subagent tokens reach the limits", () => {
  const baseline = { input_tokens: 10, output_tokens: 2, cached_input_tokens: 1, cost_usd: 0.1 };
  const t = createTranslator({ session: { native: "s-1", fork: false, totals: baseline } });
  t.onMessage(m({ type: "assistant", parent_tool_use_id: null, message: { id: "a", content: [{ type: "tool_use", id: "ag", name: "Agent", input: { description: "d" } }] } }));
  assert.deepEqual(t.onMessage(m({ type: "user", parent_tool_use_id: null, tool_use_result: { totalTokens: 321 }, message: { content: [{ type: "tool_result", tool_use_id: "ag", content: "ok" }] } })).find((o) => o.op === "call"),
    { op: "call", tokens: 321, main: false }, "a foreground subagent's tokens arrive with its result");
  assert.deepEqual(t.onMessage(m({ type: "system", subtype: "task_notification", task_id: "bg", status: "completed", output_file: "", summary: "", usage: { total_tokens: 50, tool_uses: 1, duration_ms: 1 } })),
    [{ op: "call", tokens: 50, main: false }], "and a background one's with its notification");
  t.onMessage(result());
  const o = t.outcome();
  assert.deepEqual(o.usage, { input_tokens: 3, output_tokens: 3, cached_input_tokens: 1, cost_usd: 0.5 - 0.1 }, "13/5/2 totals minus the 10/2/1 baseline");
  assert.deepEqual(o.totals, { input_tokens: 13, output_tokens: 5, cached_input_tokens: 2, cost_usd: 0.5 });
});

test("edits carry diffs: the requested change before approval, the real patch after", () => {
  assert.deepEqual(toAction("Edit", { file_path: "/w/a.txt", old_string: "two", new_string: "TWO" }),
    { kind: "edit", changes: [{ path: "/w/a.txt", change: "modify", diff: "@@ @@\n-two\n+TWO\n" }] });
  assert.deepEqual(toAction("Write", { file_path: "/w/b.txt", content: "hi\n" }),
    { kind: "edit", changes: [{ path: "/w/b.txt", change: "add", diff: "@@ -0,0 +1,1 @@\n+hi\n" }] });
  const t = createTranslator({});
  const use = (id: string, name: string, input: Record<string, unknown>) =>
    t.onMessage(m({ type: "assistant", parent_tool_use_id: null, message: { id: `msg-${id}`, content: [{ type: "tool_use", id, name, input }] } }));
  const result = (id: string, toolResult: unknown) => t.onMessage(m({ type: "user", parent_tool_use_id: null, tool_use_result: toolResult, message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } }));
  use("e1", "Edit", { file_path: "/w/a.txt", old_string: "two", new_string: "TWO" });
  const edited = result("e1", { filePath: "/w/a.txt", structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" one", "-two", "+TWO", " three"] }] });
  assert.deepEqual((edited[0] as { body: { action: unknown } }).body.action,
    { kind: "edit", changes: [{ path: "/w/a.txt", change: "modify", diff: "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n" }] });
  use("w1", "Write", { file_path: "/w/a.txt", content: "new\n" });
  const overwritten = result("w1", { type: "update", filePath: "/w/a.txt", content: "new\n", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] }] });
  assert.deepEqual((overwritten[0] as { body: { action: unknown } }).body.action,
    { kind: "edit", changes: [{ path: "/w/a.txt", change: "modify", diff: "@@ -1,1 +1,1 @@\n-old\n+new\n" }] }, "writing over a file is a modification");
});
