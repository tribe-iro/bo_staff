import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { RunManager, AWAIT_EXPIRY_MS, type Subscription } from "../src/core/runs.ts";
import { SessionIndex } from "../src/core/sessions.ts";
import { encodeSession } from "../src/ids.ts";
import { TERMINAL, type Item, type StreamEvent } from "../src/model.ts";
import { isProblem, problemName, type Problem } from "../src/problems.ts";
import type { Harness, Outcome, RunIO } from "../src/harness/port.ts";
import type { ResolvedSpec } from "../src/spec.ts";
import { collect, info, ok, registry, scripted, sleep, spec } from "./helpers.ts";

function manager(harness: Harness, maxRuns = 8, retainBytes?: number) {
  return new RunManager({ engines: registry({ harness, info: info(harness.id) }), maxRuns, retainBytes, sessions: SessionIndex.memory() });
}

async function create(runs: RunManager, s: Partial<ResolvedSpec> = {}, idem?: { key: string; hash: string }) {
  const r = await runs.create(spec({ runId: `run_${Math.random().toString(16).slice(2)}`, ...s }), { idempotency: idem });
  if ("problem" in r) throw new Error(r.problem.detail);
  return r.run;
}

/** "ok" for success, else the problem's name. */
const outcomeOf = (p: Problem | undefined) => (p ? problemName(p) : "ok");

const items = (events: StreamEvent[]) => events.filter((e): e is Extract<StreamEvent, { event: "item" }> => e.event === "item").map((e) => e.data);
const runs_ = (events: StreamEvent[]) => events.filter((e): e is Extract<StreamEvent, { event: "run" }> => e.event === "run").map((e) => e.data);
const subscribe = (runs: RunManager, id: string, after?: number): Subscription => {
  const observed = runs.observe(id, after);
  if (isProblem(observed)) throw new Error(observed.detail);
  return observed;
};
const eventsOf = (runs: RunManager, id: string, after = 0): AsyncIterable<StreamEvent> => subscribe(runs, id, after).events;

test("seq order: run first, input item, adapter items, terminal run last", async () => {
  const runs = manager(scripted("claude-code", async (_s, io) => {
    io.session("sess-1");
    io.model("m1");
    io.upsert("a", { type: "action", action: { kind: "shell", command: "ls" }, status: "running" });
    io.upsert("a", { type: "action", action: { kind: "shell", command: "ls" }, status: "completed" });
    return ok("hello");
  }));
  const run = await create(runs);
  const events = await collect(eventsOf(runs, run.id));
  const logged = events.filter((e) => "id" in e) as Extract<StreamEvent, { id: number }>[];
  assert.deepEqual(logged.map((e) => e.id), logged.map((_, i) => i + 1));
  assert.equal(logged[0]!.event, "run");
  const last = logged.at(-1)!;
  assert.ok(last.event === "run" && last.data.status === "completed");
  assert.deepEqual(last.event === "run" && last.data.result, { kind: "text", text: "hello" });
  const its = items(events);
  assert.equal(its[0]!.type, "message");
  assert.ok(its[0]!.type === "message" && its[0]!.role === "user");
  const action = its.filter((i) => i.type === "action");
  assert.equal(action.length, 2);
  assert.equal(action[0]!.id, action[1]!.id);
  assert.equal(action[0]!.created_at, action[1]!.created_at);
  assert.equal(runs.get(run.id)!.session_id, encodeSession("claude-code", "sess-1"));
  assert.equal(runs.get(run.id)!.model, "m1");
});

test("awaiting items drive waiting↔running, respond resolves, and responding twice fails", async () => {
  let resolved: unknown;
  const runs = manager(scripted("claude-code", async (_s, io) => {
    resolved = await io.await("t1", { type: "action", action: { kind: "shell", command: "rm x" }, status: "awaiting_approval" });
    return ok();
  }));
  const run = await create(runs);
  const sub = eventsOf(runs, run.id)[Symbol.asyncIterator]();
  let itemId = "";
  for (;;) {
    const { value } = await sub.next();
    if (value!.event === "item" && value!.data.type === "action") { itemId = value!.data.id; break; }
  }
  assert.equal(runs.get(run.id)!.status, "waiting");
  assert.equal(outcomeOf(runs.respond(run.id, itemId, { answers: {} })), "wrong_response_kind");
  assert.equal(outcomeOf(runs.respond(run.id, "itm_nope", { decision: "allow" })), "item_not_found");
  assert.equal(outcomeOf(runs.respond(run.id, itemId, { decision: "allow_for_run" })), "ok");
  assert.equal(outcomeOf(runs.respond(run.id, itemId, { decision: "allow" })), "item_not_awaiting");
  const rest = await collect({ [Symbol.asyncIterator]: () => sub });
  assert.deepEqual(resolved, { decision: "allow_for_run" });
  const statuses = runs_(rest).map((r) => r.status);
  assert.deepEqual(statuses, ["waiting", "running", "completed"]);
  assert.ok(items(rest).some((i) => i.type === "action" && i.status === "running"));
});

test("allow_for_run is exposed to the adapter via allowedForRun", async () => {
  let seen = false;
  const runs = manager(scripted("claude-code", async (_s, io) => {
    await io.await("t1", { type: "action", action: { kind: "mcp", server: "fx", tool: "t" }, status: "awaiting_approval" });
    seen = io.allowedForRun.has("mcp:fx/t");
    return ok();
  }));
  const run = await create(runs);
  for await (const e of eventsOf(runs, run.id)) {
    if (e.event === "item" && e.data.type === "action" && e.data.status === "awaiting_approval") runs.respond(run.id, e.data.id, { decision: "allow_for_run" });
  }
  assert.equal(seen, true);
});

test("awaiting items expire after the fixed window", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let result: unknown = "pending";
    const runs = manager(scripted("claude-code", async (_s, io) => {
      result = await io.await("q", { type: "question", questions: [{ id: "0", text: "?", multiple: false }], status: "awaiting_answer" });
      return ok();
    }));
    const run = await create(runs, { timeoutMs: AWAIT_EXPIRY_MS + 60_000 });
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(AWAIT_EXPIRY_MS + 1);
    const events = await collect(eventsOf(runs, run.id));
    assert.equal(result, undefined);
    assert.ok(items(events).some((i) => i.type === "question" && i.status === "expired"));
  } finally {
    mock.timers.reset();
  }
});

test("messages: accepted only while the adapter accepts, and require steer", async () => {
  const got: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const runs = manager(scripted("claude-code", async (_s, io) => {
    io.accept(true);
    const it = io.messages[Symbol.asyncIterator]();
    const first = await it.next();
    const part = first.value!.parts[0]!;
    got.push(part.kind === "text" ? part.text : "");
    first.value!.delivered();
    io.accept(false);
    await gate;
    return ok();
  }));
  const run = await create(runs);
  await sleep(5);
  assert.equal(outcomeOf(runs.message(run.id, [{ kind: "text", text: "steer" }])), "ok");
  await sleep(5);
  assert.equal(outcomeOf(runs.message(run.id, [{ kind: "text", text: "late" }])), "not_accepting_messages");
  release();
  const events = await collect(eventsOf(runs, run.id));
  assert.deepEqual(got, ["steer"]);
  const user = items(events).filter((i) => i.type === "message" && i.role === "user");
  assert.equal(user.length, 2, "input plus the delivered steer");
  assert.equal(outcomeOf(runs.message("run_nope", [])), "run_not_found");

  const noImages = manager(scripted("claude-code", async (_s, io) => { io.accept(true); await sleep(50); return ok(); }));
  const r3 = await create(noImages, { images: false, model: "m2" });
  await sleep(5);
  const p = noImages.message(r3.id, [{ kind: "image", path: "/x.png", media_type: "image/png" }]);
  assert.equal(p?.detail, "m2 does not accept images", "a model without image input refuses image messages too");
});

test("steers: the user item appears only on delivery; dropped and undelivered steers become notices", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const runs = manager(scripted("claude-code", async (_s, io) => {
    io.accept(true);
    const it = io.messages[Symbol.asyncIterator]();
    const a = (await it.next()).value!;
    const b = (await it.next()).value!;
    a.dropped("engine refused");
    a.delivered(); // settling twice is a no-op
    b.delivered();
    await gate;
    return ok();
  }));
  const run = await create(runs);
  await sleep(5);
  const sub = subscribe(runs, run.id, 0);
  runs.message(run.id, [{ kind: "text", text: "a" }]);
  runs.message(run.id, [{ kind: "text", text: "b" }]);
  runs.message(run.id, [{ kind: "text", text: "c" }]); // never taken by the harness
  await sleep(5);
  release();
  const all = items(await collect(sub.events));
  const texts = all.flatMap((i) => i.type === "message" && i.role === "user" ? i.content.map((p) => (p.kind === "text" ? p.text : "")) : []);
  assert.deepEqual(texts, ["hi", "b"]);
  const notices = all.filter((i) => i.type === "notice").map((i) => i.type === "notice" ? i.text : "");
  assert.deepEqual(notices, ["steering message not delivered: engine refused", "steering message not delivered: run ended"]);
});

test("subscriptions: close() releases a pending next() at once and frees the slot", async () => {
  const runs = manager(scripted("claude-code", (_s, io) => new Promise<Outcome>((resolve) => io.signal.addEventListener("abort", () => resolve(ok())))));
  const run = await create(runs);
  for (let round = 0; round < 3; round++) {
    const subs = Array.from({ length: 32 }, () => subscribe(runs, run.id));
    assert.equal(outcomeOf(runs.observe(run.id) as Problem), "too_many_subscribers");
    const pending = subs.map((s) => s.events[Symbol.asyncIterator]().next());
    const started = Date.now();
    for (const [i, s] of subs.entries()) {
      if (i % 2) s.close();
      else await s.events[Symbol.asyncIterator]().return!();
    }
    const results = await Promise.all(pending);
    assert.ok(results.every((r) => r.done), "pending next() resolves done");
    assert.ok(Date.now() - started < 50, "released immediately, not on the next event");
  }
  runs.cancel(run.id);
});

test("timeout and cancel decide the terminal status", async () => {
  const hang = scripted("claude-code", (_s, io) => new Promise<Outcome>((resolve) => io.signal.addEventListener("abort", () => resolve(ok()))));
  const runs = manager(hang);
  const timed = await create(runs, { timeoutMs: 20 });
  const t = runs_(await collect(eventsOf(runs, timed.id))).at(-1)!;
  assert.equal(t.status, "failed");
  assert.equal(t.error?.code, "timeout");

  const cancelled = await create(runs);
  assert.equal(runs.cancel(cancelled.id), undefined);
  const c = runs_(await collect(eventsOf(runs, cancelled.id))).at(-1)!;
  assert.equal(c.status, "cancelled");
  assert.equal(c.result, undefined);
  assert.equal(outcomeOf(runs.cancel("run_nope")), "run_not_found");
});

test("engine errors become engine_error failures", async () => {
  const runs = manager(scripted("claude-code", async () => { throw new Error("boom"); }));
  const run = await create(runs);
  const t = runs_(await collect(eventsOf(runs, run.id))).at(-1)!;
  assert.deepEqual(t.error, { code: "engine_error", message: "engine execution failed" });
});

test("one active run per session; idempotency keys; admission", async () => {
  const hang = scripted("claude-code", (_s, io) => new Promise<Outcome>((resolve) => io.signal.addEventListener("abort", () => resolve(ok()))));
  const runs = manager(hang, 2);
  const s = { engine: "claude-code" as const, session: { native: "s1", fork: false } };
  const first = await create(runs, s);
  const busy = await runs.create(spec({ runId: "run_b", ...s }));
  assert.ok("problem" in busy && busy.problem.type.endsWith("session_busy"));
  const fork = await runs.create(spec({ runId: "run_f", session: { native: "s1", fork: true } }));
  assert.ok("run" in fork);
  const full = await runs.create(spec({ runId: "run_x" }));
  assert.ok("problem" in full && full.problem.type.endsWith("too_many_runs"));
  runs.cancel(first.id);
  runs.cancel("run_f");
  await sleep(10);

  const again = await create(runs, {}, { key: "k", hash: "h1" });
  const same = await runs.create(spec({ runId: "run_other" }), { idempotency: { key: "k", hash: "h1" } });
  assert.ok("run" in same && same.run.id === again.id && same.replayed);
  const lookup = runs.replay("k", "h1");
  assert.ok(lookup && "run" in lookup && lookup.replayed && lookup.run.id === again.id);
  assert.equal(runs.replay("unknown", "h1"), undefined);
  const mismatch = await runs.create(spec({ runId: "run_other2" }), { idempotency: { key: "k", hash: "h2" } });
  assert.ok("problem" in mismatch && mismatch.problem.type.endsWith("idempotency_mismatch"));
  await runs.shutdown();
});

test("observe replays after a sequence number; list orders active first", async () => {
  const runs = manager(scripted("claude-code", async (_s, io) => { io.upsert("x", { type: "notice", level: "info", text: "n" }); return ok(); }));
  const run = await create(runs);
  const all = await collect(eventsOf(runs, run.id));
  const tail = await collect(eventsOf(runs, run.id, 2));
  assert.deepEqual(tail, all.filter((e) => "id" in e && e.id > 2));
  assert.equal(outcomeOf(runs.observe("run_nope", 0) as Problem), "run_not_found");
  assert.equal(runs.list()[0]!.id, run.id);
  assert.ok(subscribe(runs, run.id).seq >= all.length);
});

test("adapter upserts cannot override an awaiting item", async () => {
  const runs = manager(scripted("claude-code", async (_s, io: RunIO) => {
    const p = io.await("k", { type: "action", action: { kind: "shell", command: "x" }, status: "awaiting_approval" });
    io.upsert("k", { type: "action", action: { kind: "shell", command: "x" }, status: "running" });
    await p;
    return ok();
  }));
  const run = await create(runs);
  const statuses: string[] = [];
  for await (const e of eventsOf(runs, run.id)) {
    if (e.event !== "item" || e.data.type !== "action") continue;
    statuses.push(e.data.status);
    if (e.data.status === "awaiting_approval") runs.respond(run.id, e.data.id, { decision: "deny" });
  }
  assert.deepEqual(statuses, ["awaiting_approval", "denied"], "the running upsert while awaiting was ignored");
});

test("core rejects successful structured output that violates the compiled schema", async () => {
  const validate = Object.assign((value: unknown) => {
    const ok = typeof value === "object" && value !== null && (value as { n?: unknown }).n === 1;
    validate.errors = ok ? null : [{ instancePath: "/n", message: "must be equal to 1" }];
    return ok;
  }, { errors: null as null | { instancePath: string; message: string }[] });
  const runs = manager(scripted("claude-code", async () => ({
    ok: true, result: { kind: "data", data: { n: 2 } }, usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
  })));
  const run = await create(runs, { schema: { type: "object" }, validateOutput: validate as never });
  const terminal = runs_(await collect(eventsOf(runs, run.id))).at(-1)!;
  assert.deepEqual(terminal.error, { code: "invalid_output", message: "structured output does not match the requested schema", path: "/n" });
});

test("unique-item exhaustion fails the run without losing its terminal event", async () => {
  const runs = manager(scripted("claude-code", async (_spec, io) => {
    for (let i = 0; i <= 10_000; i++) io.upsert(`n:${i}`, { type: "notice", level: "info", text: String(i) });
    return ok();
  }));
  const run = await create(runs);
  await collect(eventsOf(runs, run.id));
  let terminal = runs.get(run.id)!;
  while (!TERMINAL.has(terminal.status)) { await sleep(1); terminal = runs.get(run.id)!; }
  assert.equal(terminal.error?.code, "resource_exhausted");
  assert.equal(terminal.status, "failed");
  const current = subscribe(runs, run.id);
  const terminalEvents = await collect(eventsOf(runs, run.id, current.seq - 1));
  assert.equal(terminalEvents.at(-1)?.event, "run");
});

test("finished runs are forgotten oldest-first once the retained byte budget is exceeded", async () => {
  const runs = manager(scripted("claude-code", async (_s, io) => { io.upsert("n", { type: "notice", level: "info", text: "x".repeat(600) }); return ok(); }), 8, 2_500);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const run = await create(runs);
    await collect(eventsOf(runs, run.id));
    ids.push(run.id);
  }
  await sleep(10);
  assert.equal(runs.get(ids[0]!), undefined, "oldest evicted");
  assert.ok(runs.get(ids[2]!), "newest retained");
});

test("idempotency snapshots survive finished-run eviction", async () => {
  const runs = manager(scripted("claude-code", async () => ok()));
  const first = await create(runs, {}, { key: "durable", hash: "same" });
  await collect(eventsOf(runs, first.id));
  for (let i = 0; i < 260; i++) {
    const run = await create(runs);
    await collect(eventsOf(runs, run.id));
  }
  await sleep(10);
  assert.equal(runs.get(first.id), undefined);
  const replay = await runs.create(spec({ runId: "run_must_not_execute" }), { idempotency: { key: "durable", hash: "same" } });
  assert.ok("run" in replay && replay.run.id === first.id && replay.run.status === "completed" && replay.replayed);
});

test("cancel settles awaiting items: an action is denied with the reason, a question expires", async () => {
  const runs = manager(scripted("claude-code", async (_s, io) => {
    void io.await("act", { type: "action", action: { kind: "shell", command: "rm -rf x" }, status: "awaiting_approval" });
    void io.await("ask", { type: "question", questions: [{ id: "q", text: "?", multiple: false }], status: "awaiting_answer" });
    await new Promise((resolve) => io.signal.addEventListener("abort", resolve));
    return ok();
  }));
  const run = await create(runs, { interactive: true });
  await sleep(20);
  assert.equal(runs.cancel(run.id), undefined);
  const final = new Map(items(await collect(eventsOf(runs, run.id))).map((i) => [i.id, i]));
  const bodies = [...final.values()].filter((i) => i.type !== "message");
  assert.deepEqual(bodies.map((i) => [i.type, "status" in i ? i.status : undefined, i.type === "action" ? i.reason : undefined]), [
    ["action", "denied", "run ended"], ["question", "expired", undefined],
  ]);
});

test("runs record their session in the index: title from the first prompt, model, runs counted, A2A context", async () => {
  const runs = manager(scripted("claude-code", async (s, io) => {
    io.session(s.session?.native ?? "n1");
    io.model("m1");
    return ok();
  }));
  const first = await create(runs, { input: [{ kind: "text", text: "fix the flaky test\nthen more" }], root: "/w" }, undefined);
  await collect(eventsOf(runs, first.id));
  const second = await runs.create(spec({ runId: "run_second", root: "/w", session: { native: "n1", fork: false } }), { context: "ctx9" });
  assert.ok("run" in second);
  await collect(eventsOf(runs, second.run.id));
  const [session] = runs.sessions.list("/w");
  assert.deepEqual({ ...session, created_at: "", updated_at: "" }, {
    id: encodeSession("claude-code", "n1"), engine: "claude-code", workspace: "/w", title: "fix the flaky test", model: "m1", runs: 2,
    created_at: "", updated_at: "",
  });
  assert.equal(runs.sessions.latest({ context: "ctx9" }), undefined, "a context is recorded only by the run that starts the session");
});

test("limits are bo's: the run fails with limit_exceeded at the first model call past max_turns or max_tokens", async () => {
  const calls = (n: number, tokens: number, main = true) => scripted("claude-code", async (_s, io) => {
    for (let i = 0; i < n; i++) io.modelCall(tokens, main);
    await new Promise((resolve) => io.signal.addEventListener("abort", resolve));
    return ok();
  });
  const byTurns = manager(calls(3, 10));
  const t = await create(byTurns, { limits: { maxTurns: 2 } });
  const turned = runs_(await collect(eventsOf(byTurns, t.id))).at(-1)!;
  assert.deepEqual([turned.status, turned.error], ["failed", { code: "limit_exceeded", message: "the run went past max_turns (2)" }]);

  const subagents = manager(calls(5, 10, false));
  const s = await create(subagents, { limits: { maxTurns: 2, maxTokens: 45 } });
  const spent = runs_(await collect(eventsOf(subagents, s.id))).at(-1)!;
  assert.deepEqual(spent.error, { code: "limit_exceeded", message: "the run went past max_tokens (45)" }, "subagent calls count toward tokens, not turns");

  const within = manager(scripted("claude-code", async (_s, io) => { io.modelCall(10, true); io.modelCall(10, true); return ok(); }));
  const w = await create(within, { limits: { maxTurns: 2, maxTokens: 20 } });
  assert.equal(runs_(await collect(eventsOf(within, w.id))).at(-1)!.status, "completed", "exactly at a limit is within it");
});
