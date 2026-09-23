// Live A2A v1 JSON-RPC binding against a real server and real models.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { LIVE_TIMEOUT, enginesUnderTest, pgrep, startBo, token, waitFor, workspace, type BoProcess } from "./harness.ts";

const server: BoProcess = await startBo();
after(async () => { await server.stop(); });
const targets = await enginesUnderTest(server.bo);

type Obj = Record<string, any>;
let rpcId = 0;

async function rpc(method: string, params: unknown): Promise<Obj> {
  const res = await fetch(`${server.url}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json", "a2a-version": "1.0", "a2a-extensions": "urn:bo:a2a:run:v1" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return res.json() as Promise<Obj>;
}

const ext = (spec: Obj) => ({ "urn:bo:a2a:run:v1": spec });
const msg = (text: string, extra: Obj = {}) => ({ messageId: token("m"), role: "ROLE_USER", parts: [{ text }], ...extra });
const artifactText = (task: Obj) => String(task.artifacts?.[0]?.parts?.[0]?.text ?? JSON.stringify(task.artifacts?.[0]?.parts?.[0]?.data ?? ""));

async function settle(taskId: string): Promise<Obj> {
  for (;;) {
    const r = await rpc("GetTask", { id: taskId });
    if (/COMPLETED|FAILED|CANCELED/.test(r.result.status.state)) return r.result;
    await new Promise((res) => setTimeout(res, 1000));
  }
}

for (const target of targets) {
  const harness = target.id;
  describe(`${harness}: A2A live`, { skip: target.skip, timeout: 20 * LIVE_TIMEOUT }, () => {
    test("agent card lists the engine", async () => {
      const card = await (await fetch(`${server.url}/.well-known/agent-card.json`)).json() as Obj;
      assert.ok(card.skills.some((s: Obj) => s.id === harness));
    });

    test("SendMessage blocks until completion; contextId continues the session", { timeout: 2 * LIVE_TIMEOUT }, async () => {
      const root = await workspace();
      const secret = token("MANGO");
      const first = await rpc("SendMessage", { message: msg(`Remember the code word ${secret}. Reply only with OK.`, { metadata: ext({ workspace: { root }, engine: harness }) }) });
      assert.equal(first.result.task.status.state, "TASK_STATE_COMPLETED", JSON.stringify(first));
      const contextId = first.result.task.contextId;
      assert.match(contextId, /^ctx_/);
      const second = await rpc("SendMessage", { message: msg("What was the code word? Reply with only the code word.", { contextId, metadata: ext({ workspace: { root } }) }) });
      assert.equal(second.result.task.status.state, "TASK_STATE_COMPLETED", JSON.stringify(second));
      assert.ok(artifactText(second.result.task).includes(secret), JSON.stringify(second.result.task.artifacts));
      assert.equal(second.result.task.contextId, contextId);
    });

    test("SendStreamingMessage streams status updates, the result artifact, and a terminal state", { timeout: LIVE_TIMEOUT }, async () => {
      const t = token("STREAM");
      const res = await fetch(`${server.url}/a2a`, {
        method: "POST", headers: { "content-type": "application/json", "a2a-version": "1.0", "a2a-extensions": "urn:bo:a2a:run:v1" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "SendStreamingMessage", params: { message: msg(`Reply with exactly: ${t}`, { metadata: ext({ workspace: { root: await workspace() }, engine: harness }) }) } }),
      });
      assert.equal(res.headers.get("content-type"), "text/event-stream");
      const frames = (await res.text()).split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)).result as Obj);
      assert.ok("task" in frames[0]!);
      const artifact = frames.find((f) => f.artifactUpdate)?.artifactUpdate;
      assert.ok(String(artifact?.artifact?.parts?.[0]?.text).includes(t), JSON.stringify(artifact));
      assert.equal(frames.at(-1)!.statusUpdate.status.state, "TASK_STATE_COMPLETED");
      assert.ok(frames.some((f) => f.statusUpdate?.metadata?.["urn:bo:a2a:run:v1"]?.item), "bo items ride in status-update metadata");
    });

    test("INPUT_REQUIRED: the pending approval is answered with a data part", { timeout: LIVE_TIMEOUT }, async () => {
      const root = await workspace();
      const first = await rpc("SendMessage", { message: msg("Create b.txt containing ok.", { metadata: ext({ workspace: { root }, engine: harness, permissions: { access: "read" }, interactive: true }) }) });
      const task = first.result.task;
      assert.equal(task.status.state, "TASK_STATE_INPUT_REQUIRED", JSON.stringify(first));
      const pending = task.status.message.parts[0].data;
      assert.equal(pending.type, "action");
      const answer = await rpc("SendMessage", { message: msg("", { taskId: task.id, parts: [{ data: { item_id: pending.id, response: { decision: "allow" } } }] }) });
      assert.ok(answer.result, JSON.stringify(answer));
      let final = await settle(task.id);
      while (final.status.state === "TASK_STATE_INPUT_REQUIRED") {
        const next = final.status.message.parts[0].data;
        await rpc("SendMessage", { message: msg("", { taskId: task.id, parts: [{ data: { item_id: next.id, response: { decision: "allow" } } }] }) });
        final = await settle(task.id);
      }
      assert.equal(final.status.state, "TASK_STATE_COMPLETED", JSON.stringify(final.status));
      assert.ok(existsSync(path.join(root, "b.txt")));
    });

    test("CancelTask stops a working task", { timeout: LIVE_TIMEOUT }, async () => {
      const marker = `sleep ${1400 + Math.floor(Math.random() * 90)}`;
      const first = await rpc("SendMessage", {
        message: msg(`Run the shell command \`${marker}\` and wait for it.`, { metadata: ext({ workspace: { root: await workspace() }, engine: harness, permissions: { access: "full" } }) }),
        configuration: { returnImmediately: true },
      });
      const id = first.result.task.id;
      assert.ok(await waitFor(() => pgrep(marker).length > 0, LIVE_TIMEOUT / 2, 500), "agent started the command");
      const cancel = await rpc("CancelTask", { id });
      assert.ok(cancel.result, JSON.stringify(cancel));
      const final = await settle(id);
      assert.equal(final.status.state, "TASK_STATE_CANCELED");
      assert.ok(await waitFor(() => pgrep(marker).length === 0, 20_000));
      const again = await rpc("CancelTask", { id });
      assert.equal(again.error.code, -32002);
    });
  });
}
