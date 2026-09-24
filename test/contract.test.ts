// The contract is honoured: the published documents are current, and everything the server emits — every event,
// run, item, session, engine and problem — validates against the published schemas.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ValidateFunction } from "ajv/dist/ajv.js";
import { openApiDocument, schemaDocument } from "../src/contract/documents.ts";
import { SCHEMAS } from "../src/contract/schema.ts";
import { ajv } from "../src/contract/validate.ts";
import { parseSse } from "../src/client.ts";
import { startServer, type BoServer } from "../src/http/server.ts";
import type { StreamEvent } from "../src/model.ts";
import { ok, scripted, tmpdir } from "./helpers.ts";

const servers: BoServer[] = [];
after(async () => { await Promise.all(servers.map((s) => s.close())); });

const validators = new Map<string, ValidateFunction>();
function conforms(name: keyof typeof SCHEMAS, value: unknown): void {
  let validate = validators.get(name);
  if (!validate) validators.set(name, validate = ajv.compile(SCHEMAS[name]));
  assert.ok(validate(value), `${name} does not conform: ${JSON.stringify(validate.errors)}\n${JSON.stringify(value)}`);
}

test("the published documents are current (npm run contract)", async () => {
  const dir = path.join(import.meta.dirname, "..", "contract");
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "bo.v1.schema.json"), "utf8")), schemaDocument());
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "openapi.json"), "utf8")), openApiDocument());
  assert.ok(ajv.validateSchema(schemaDocument()), "the schema document is a valid JSON Schema");
});

test("every event, run, item, session, engine and problem the server emits conforms to the contract", async () => {
  const s = await startServer({
    port: 0, env: { PATH: process.env.PATH ?? "" }, sessionsFile: null,
    engines: [scripted("claude-code", async (_spec, io) => {
      io.session("native-contract");
      io.model("m1");
      io.modelCall(120, true);
      const edit = { kind: "edit" as const, changes: [{ path: "/w/a.ts", change: "modify" as const, diff: "@@ -1,1 +1,1 @@\n-a\n+b\n" }] };
      await io.await("e", { type: "action", action: edit, status: "awaiting_approval", reason: "outside the workspace" });
      // Deltas are live-only: emitted once the caller answered, so the subscriber is certainly attached.
      io.upsert("m", { type: "message", role: "agent", content: [{ kind: "text", text: "" }], status: "in_progress" });
      io.delta("m", "Looking");
      io.upsert("m", { type: "message", role: "agent", content: [{ kind: "text", text: "Looking." }], status: "completed" });
      io.upsert("r", { type: "reasoning", text: "the parser drops a token" });
      io.upsert("p", { type: "plan", steps: [{ text: "fix", status: "in_progress" }, { text: "test", status: "pending" }] });
      io.upsert("e", { type: "action", action: edit, status: "completed", outcome: { excerpt: "ok" } });
      io.upsert("x", { type: "action", action: { kind: "shell", command: "false" }, status: "failed", outcome: { exit_code: 1, excerpt: "" } });
      io.upsert("d", { type: "action", action: { kind: "delegate", subagent: "helper", task: "look" }, status: "running" });
      io.upsert("c", { type: "message", role: "agent", content: [{ kind: "text", text: "from a subagent" }], status: "completed" }, "d");
      await io.await("q", { type: "question", questions: [{ id: "q1", text: "Which?", options: ["a", "b"], multiple: false }], status: "awaiting_answer" });
      io.upsert("n", { type: "notice", level: "warning", text: "API retry 1/10 in 2s" });
      return { ...ok("done"), usage: { input_tokens: 120, output_tokens: 9, cached_input_tokens: 80, cost_usd: 0.01 } };
    })],
  });
  servers.push(s);
  const root = await tmpdir();
  const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const created = await post(`${s.url}/v1/runs`, { input: [{ kind: "text", text: "go" }, { kind: "data", data: { n: 1 } }], workspace: { root }, interactive: true });
  const run = await created.json() as { id: string };
  conforms("Run", run);
  const events: StreamEvent[] = [];
  for await (const e of parseSse((await fetch(`${s.url}/v1/runs/${run.id}/events`)).body!)) {
    conforms("StreamEvent", e);
    events.push(e);
    if (e.event === "item" && e.data.type === "action" && e.data.status === "awaiting_approval") {
      await post(`${s.url}/v1/runs/${run.id}/items/${e.data.id}/response`, { decision: "allow" });
    }
    if (e.event === "item" && e.data.type === "question" && e.data.status === "awaiting_answer") {
      await post(`${s.url}/v1/runs/${run.id}/items/${e.data.id}/response`, { answers: { q1: ["a"] } });
    }
    if (e.event === "run" && ["completed", "failed", "cancelled"].includes(e.data.status)) break;
  }
  const kinds = new Set(events.map((e) => (e.event === "item" ? `item:${e.data.type}` : e.event)));
  for (const k of ["run", "delta", "item:message", "item:reasoning", "item:plan", "item:action", "item:question", "item:notice"]) assert.ok(kinds.has(k), `saw ${k}`);

  const json = async (url: string) => (await fetch(url)).json();
  conforms("Run", await json(`${s.url}/v1/runs/${run.id}`));
  for (const r of await json(`${s.url}/v1/runs`) as unknown[]) conforms("Run", r);
  for (const e of await json(`${s.url}/v1/engines`) as unknown[]) conforms("EngineInfo", e);
  const sessions = await json(`${s.url}/v1/sessions`) as { id: string }[];
  assert.equal(sessions.length, 1);
  for (const x of sessions) conforms("Session", x);
  for (const r of await json(`${s.url}/v1/sessions/${encodeURIComponent(sessions[0]!.id)}/runs`) as unknown[]) conforms("SessionRun", r);
  for (const bad of [
    await post(`${s.url}/v1/runs`, { input: [], workspace: { root: "relative" } }),
    await fetch(`${s.url}/v1/runs/run_nope`),
    await fetch(`${s.url}/v1/sessions/ses_nope`),
  ]) conforms("Problem", await bad.json());
});
