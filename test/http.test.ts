import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { request } from "node:http";
import { startServer, type BoServer } from "../src/http/server.ts";
import type { Outcome } from "../src/harness/port.ts";
import { parseSse } from "../src/client.ts";
import type { StreamEvent } from "../src/model.ts";
import { info, ok, scripted, sleep, tmpdir } from "./helpers.ts";

const servers: BoServer[] = [];
after(async () => { await Promise.all(servers.map((s) => s.close())); });

async function boot(env: Record<string, string> = {}, script = async (_s: unknown, io: import("../src/harness/port.ts").RunIO): Promise<Outcome> => {
  io.session("s1");
  const r = await io.await("a", { type: "action", action: { kind: "shell", command: "ls" }, status: "awaiting_approval" });
  // Deltas are live-only: emitted after the caller responded, so the subscriber is certainly attached.
  io.delta("nope", "x");
  io.upsert("m", { type: "message", role: "agent", content: [{ kind: "text", text: "" }], status: "in_progress" });
  io.delta("m", "hel");
  io.upsert("m", { type: "message", role: "agent", content: [{ kind: "text", text: "hello" }], status: "completed" });
  return ok(r && "decision" in r ? r.decision : "none");
}) {
  const s = await startServer({ port: 0, env: { ...env, PATH: process.env.PATH ?? "" }, engines: [scripted("claude-code", script)], sessionsFile: null });
  servers.push(s);
  return s;
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function events(url: string, lastEventId?: number): Promise<StreamEvent[]> {
  const res = await fetch(url, { headers: lastEventId ? { "last-event-id": String(lastEventId) } : {} });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const out: StreamEvent[] = [];
  for await (const e of parseSse(res.body!)) out.push(e);
  return out;
}

test("full lifecycle: create, stream, respond, replay", async () => {
  const s = await boot();
  const root = await tmpdir();
  const created = await post(`${s.url}/v1/runs`, { input: [{ kind: "text", text: "hi" }], workspace: { root }, interactive: true });
  assert.equal(created.status, 201);
  const run = await created.json() as { id: string };
  assert.equal(created.headers.get("location"), `/v1/runs/${run.id}`);

  const seen: StreamEvent[] = [];
  const res = await fetch(`${s.url}/v1/runs/${run.id}/events`);
  for await (const e of parseSse(res.body!)) {
    seen.push(e);
    if (e.event === "item" && e.data.type === "action" && e.data.status === "awaiting_approval") {
      const r1 = await post(`${s.url}/v1/runs/${run.id}/items/${e.data.id}/response`, { decision: "allow" });
      assert.equal(r1.status, 204);
      const r2 = await post(`${s.url}/v1/runs/${run.id}/items/${e.data.id}/response`, { decision: "allow" });
      assert.equal(r2.status, 409);
      assert.equal((await r2.json() as { type: string }).type, "urn:bo:problem:item_not_awaiting");
    }
  }
  const last = seen.at(-1)!;
  assert.ok(last.event === "run" && last.data.status === "completed");
  assert.deepEqual(last.event === "run" && last.data.result, { kind: "text", text: "allow" });
  assert.ok(seen.some((e) => e.event === "delta" && e.data.text === "hel"));
  assert.ok(seen.some((e) => e.event === "run" && e.data.status === "waiting"));

  const replay = await events(`${s.url}/v1/runs/${run.id}/events`);
  assert.ok(!replay.some((e) => e.event === "delta"), "deltas are not replayed");
  const resumed = await events(`${s.url}/v1/runs/${run.id}/events`, 3);
  assert.ok(resumed.every((e) => "id" in e && e.id > 3));

  const got = await fetch(`${s.url}/v1/runs/${run.id}`);
  assert.equal((await got.json() as { status: string }).status, "completed");
  const list = await (await fetch(`${s.url}/v1/runs`)).json() as unknown[];
  assert.equal(list.length, 1);
  const hs = await (await fetch(`${s.url}/v1/engines`)).json() as { id: string }[];
  assert.equal(hs[0]!.id, "claude-code");
});

test("problems: validation, media type, size, json, routes, lookups", async () => {
  const s = await boot();
  const bad = await post(`${s.url}/v1/runs`, { input: [], workspace: { root: "x" } });
  assert.equal(bad.status, 422);
  assert.equal(bad.headers.get("content-type"), "application/problem+json");
  const p = await bad.json() as { type: string; errors: { pointer: string }[] };
  assert.equal(p.type, "urn:bo:problem:invalid_spec");
  assert.ok(p.errors.some((e) => e.pointer === "/input"));
  assert.equal((await fetch(`${s.url}/v1/runs`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" })).status, 415);
  assert.equal((await fetch(`${s.url}/v1/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(1024 * 1024 + 1) })).status, 413);
  assert.equal((await fetch(`${s.url}/v1/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status, 400);
  assert.equal((await fetch(`${s.url}/nope`)).status, 404);
  assert.equal((await fetch(`${s.url}/v1/harnesses`)).status, 404);
  assert.equal((await post(`${s.url}/v1/runs`, { input: [{ kind: "text", text: "x" }], workspace: { root: await tmpdir() }, agent: {} })).status, 422);
  assert.equal((await fetch(`${s.url}/v1/runs/run_x`)).status, 404);
  assert.equal((await fetch(`${s.url}/v1/runs/run_x/events`)).status, 404);
  assert.equal((await post(`${s.url}/v1/runs/run_x/cancel`, {})).status, 404);
  assert.equal((await post(`${s.url}/v1/runs/run_x/messages`, { content: [{ kind: "text", text: "x" }] })).status, 404);
  assert.equal((await post(`${s.url}/v1/runs/run_x/items/i/response`, { decision: "nope" })).status, 422);
  assert.equal((await fetch(`${s.url}/v1/runs/%E0`)).status, 404, "malformed escapes are a 404, not a 500");
  const del = await fetch(`${s.url}/v1/runs`, { method: "DELETE" });
  assert.equal(del.status, 405);
  assert.deepEqual(del.headers.get("allow")?.split(", ").sort(), ["GET", "POST"]);
  assert.equal((await fetch(`${s.url}/v1/runs/run_x/cancel`)).status, 405);
  const big = await fetch(`${s.url}/v1/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(2 * 1024 * 1024) });
  assert.equal(big.status, 413);
  assert.equal(big.headers.get("connection"), "close");
  const badResponse = await (await post(`${s.url}/v1/runs/run_x/items/i/response`, { answers: { q: [1] } })).json() as { type: string; errors: { pointer: string }[] };
  assert.equal(badResponse.type, "urn:bo:problem:invalid_request");
  assert.deepEqual(badResponse.errors.map((e) => e.pointer), ["/answers/q/0"], "the offending entry itself");
});

test("SSE disconnects release their subscription immediately, even while the run waits", async () => {
  const s = await boot();
  const run = await (await post(`${s.url}/v1/runs`, { input: [{ kind: "text", text: "hi" }], workspace: { root: await tmpdir() }, interactive: true })).json() as { id: string };
  for (let i = 0; i < 40; i++) {
    const ac = new AbortController();
    const res = await fetch(`${s.url}/v1/runs/${run.id}/events`, { signal: ac.signal });
    assert.equal(res.status, 200, `connection ${i}`);
    await res.body!.getReader().read();
    ac.abort();
    await sleep(5);
  }
  const last = await fetch(`${s.url}/v1/runs/${run.id}/events`);
  assert.equal(last.status, 200);
  await last.body!.cancel();
  await post(`${s.url}/v1/runs/${run.id}/cancel`, {});
});

test("unavailable engines are re-probed lazily", async () => {
  let probes = 0;
  const flaky = { ...scripted("claude-code", async () => ok()), probe: async () => info("claude-code", ++probes === 1 ? { available: false, reason: "warming up" } : {}) };
  const s = await startServer({ port: 0, env: { PATH: process.env.PATH ?? "" }, engines: [flaky], reprobeMs: 0, sessionsFile: null });
  servers.push(s);
  const body = { input: [{ kind: "text", text: "x" }], workspace: { root: await tmpdir() } };
  const engines = await (await fetch(`${s.url}/v1/engines`)).json() as { available: boolean }[];
  assert.equal(engines[0]!.available, true);
  assert.equal((await post(`${s.url}/v1/runs`, body)).status, 201);
  assert.equal(probes, 2, "an available engine is not probed again");
});

test("messages, cancel, and admission", async () => {
  const hang = async (_s: unknown, io: import("../src/harness/port.ts").RunIO): Promise<Outcome> => {
    io.accept(true);
    await new Promise((r) => io.signal.addEventListener("abort", r));
    return ok();
  };
  const s = await boot({ BO_MAX_RUNS: "1" }, hang);
  const root = await tmpdir();
  const r1 = await (await post(`${s.url}/v1/runs`, { input: [{ kind: "text", text: "a" }], workspace: { root } })).json() as { id: string };
  await sleep(20);
  const busy = await post(`${s.url}/v1/runs`, { input: [{ kind: "text", text: "b" }], workspace: { root } });
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get("retry-after"), "5");
  assert.equal((await post(`${s.url}/v1/runs/${r1.id}/messages`, { content: [{ kind: "text", text: "steer" }] })).status, 202);
  assert.equal((await post(`${s.url}/v1/runs/${r1.id}/messages`, { content: [] })).status, 422);
  assert.equal((await post(`${s.url}/v1/runs/${r1.id}/cancel`, {})).status, 202);
  const evs = await events(`${s.url}/v1/runs/${r1.id}/events`);
  const last = evs.at(-1)!;
  assert.ok(last.event === "run" && last.data.status === "cancelled");
});

test("idempotency key returns the same run", async () => {
  const s = await boot({}, async () => ok());
  const root = await tmpdir();
  const body = { input: [{ kind: "text", text: "a" }], workspace: { root } };
  const first = await post(`${s.url}/v1/runs`, body, { "idempotency-key": "k1" });
  assert.equal(first.status, 201);
  const a = await first.json() as { id: string };
  const again = await post(`${s.url}/v1/runs`, body, { "idempotency-key": "k1" });
  assert.equal(again.status, 200, "a replay is not a creation");
  assert.equal(again.headers.get("location"), `/v1/runs/${a.id}`);
  const b = await again.json() as { id: string };
  assert.equal(a.id, b.id);
  await rm(root, { recursive: true });
  const replayed = await post(`${s.url}/v1/runs`, body, { "idempotency-key": "k1" });
  assert.equal(replayed.status, 200, "replays answer before validation (the workspace no longer exists)");
  const c = await post(`${s.url}/v1/runs`, { ...body, interactive: true }, { "idempotency-key": "k1" });
  assert.equal(c.status, 422);
});

test("bearer auth and loopback guard", async () => {
  const s = await boot({ BO_TOKEN: "secret" }, async () => ok());
  assert.equal((await fetch(`${s.url}/v1/engines`)).status, 401);
  assert.equal((await fetch(`${s.url}/v1/engines`, { headers: { authorization: "Bearer secret" } })).status, 200);
  assert.equal((await fetch(`${s.url}/.well-known/agent-card.json`)).status, 200, "the agent card is public discovery");
  assert.equal((await fetch(`${s.url}/a2a`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  await assert.rejects(startServer({ port: 70_000, env: {}, engines: [] }), /port must be/);
  await assert.rejects(startServer({ host: "0.0.0.0", port: 0, env: {}, engines: [] }), /BO_TOKEN/);
});

test("a tokenless server only answers to loopback host names (DNS rebinding)", async () => {
  const s = await boot({}, async () => ok());
  const port = new URL(s.url).port;
  const status = (host: string) => new Promise<number>((resolve, reject) => {
    request({ host: "127.0.0.1", port, path: "/v1/engines", headers: { host } }, (res) => { res.resume(); resolve(res.statusCode!); }).on("error", reject).end();
  });
  assert.equal(await status(`evil.example:${port}`), 403);
  assert.equal(await status("evil.example"), 403);
  assert.equal(await status(`127.0.0.1:${port}`), 200);
  assert.equal(await status(`localhost:${port}`), 200);
  assert.equal(await status(`[::1]:${port}`), 200);
  const token = await boot({ BO_TOKEN: "t" }, async () => ok());
  const tokenPort = new URL(token.url).port;
  const withToken = await new Promise<number>((resolve, reject) => {
    request({ host: "127.0.0.1", port: tokenPort, path: "/v1/engines", headers: { host: "bo.internal", authorization: "Bearer t" } }, (res) => { res.resume(); resolve(res.statusCode!); }).on("error", reject).end();
  });
  assert.equal(withToken, 200, "with a token, the token is the boundary");
});

test("sessions: a finished run is listed for its workspace, and session.latest continues it", async () => {
  const seen: (string | undefined)[] = [];
  const s = await boot({}, async (spec, io) => {
    const r = spec as import("../src/spec.ts").ResolvedSpec;
    seen.push(r.session?.native);
    io.session(r.session?.native ?? "first");
    return ok();
  });
  const root = await tmpdir();
  const created = await (await post(`${s.url}/v1/runs`, { input: [{ kind: "text", text: "start here" }], workspace: { root } })).json() as { id: string };
  await events(`${s.url}/v1/runs/${created.id}/events`);
  const listed = await (await fetch(`${s.url}/v1/sessions?workspace=${encodeURIComponent(root)}`)).json() as { title: string; runs: number }[];
  assert.deepEqual(listed.map((x) => [x.title, x.runs]), [["start here", 1]]);
  assert.equal(((await (await fetch(`${s.url}/v1/sessions`)).json()) as unknown[]).length, 1);
  assert.equal((await fetch(`${s.url}/v1/sessions?workspace=relative`)).status, 422);
  const next = await (await post(`${s.url}/v1/runs`, { input: [{ kind: "text", text: "and then" }], workspace: { root }, session: { latest: true } })).json() as { id: string };
  await events(`${s.url}/v1/runs/${next.id}/events`);
  assert.deepEqual(seen, [undefined, "first"]);
});

test("session history: GET a session and its runs (items in final state), DELETE forgets it, 404 after", async () => {
  const s = await boot({}, async (spec, io) => {
    const r = spec as import("../src/spec.ts").ResolvedSpec;
    io.session(r.session?.native ?? "native-h");
    io.upsert("a", { type: "action", action: { kind: "shell", command: "ls" }, status: "running" });
    io.upsert("a", { type: "action", action: { kind: "shell", command: "ls" }, status: "completed" });
    return ok("done");
  });
  const root = await tmpdir();
  for (const text of ["first", "second"]) {
    const run = await (await post(`${s.url}/v1/runs`, { input: [{ kind: "text", text }], workspace: { root }, ...(text === "second" ? { session: { latest: true } } : {}) })).json() as { id: string };
    await events(`${s.url}/v1/runs/${run.id}/events`);
  }
  const [session] = await (await fetch(`${s.url}/v1/sessions?workspace=${encodeURIComponent(root)}`)).json() as { id: string }[];
  const id = encodeURIComponent(session!.id);
  assert.equal(((await (await fetch(`${s.url}/v1/sessions/${id}`)).json()) as { runs: number }).runs, 2);
  const runs = await (await fetch(`${s.url}/v1/sessions/${id}/runs`)).json() as { run: { status: string; result: { text: string } }; items: { type: string; status?: string }[] }[];
  assert.deepEqual(runs.map((r) => r.run.result.text), ["done", "done"]);
  assert.deepEqual(runs[0]!.items.map((i) => `${i.type}:${i.status}`), ["message:completed", "action:completed"], "one entry per item, in its final state");
  assert.equal((await fetch(`${s.url}/v1/sessions/${id}`, { method: "DELETE" })).status, 204);
  const gone = await fetch(`${s.url}/v1/sessions/${id}/runs`);
  assert.equal(gone.status, 404);
  assert.equal(((await gone.json()) as { type: string }).type, "urn:bo:problem:session_not_found");
});
