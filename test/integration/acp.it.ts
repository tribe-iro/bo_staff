// Live ACP: a real `bo acp` subprocess driven by the ACP SDK's client over its stdio, against a real server, real
// engines and models. One-line prompts.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { LIVE_TIMEOUT, ROOT, enginesUnderTest, startBo, token, workspace, type BoProcess } from "./harness.ts";

const server: BoProcess = await startBo();
after(async () => { await server.stop(); });
const targets = await enginesUnderTest(server.bo);

interface Editor { agent: acp.ClientSideConnection; updates: acp.SessionNotification[]; asked: acp.RequestPermissionRequest[]; stop(): void }

/** An editor: `bo acp` as a subprocess, the SDK client on its stdio. */
async function editor(choose: acp.RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "allow" } }): Promise<Editor> {
  const child = spawn(process.execPath, [path.join(ROOT, "bin", "bo.mjs"), "acp", "--url", server.url], {
    stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, XDG_CONFIG_HOME: server.stateHome },
  });
  const updates: acp.SessionNotification[] = [];
  const asked: acp.RequestPermissionRequest[] = [];
  const agent = new acp.ClientSideConnection(() => ({
    sessionUpdate: async (n) => { updates.push(n); },
    requestPermission: async (r) => { asked.push(r); return choose; },
  }), acp.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
  await agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  return { agent, updates, asked, stop: () => child.kill() };
}

const said = (updates: acp.SessionNotification[]) =>
  updates.filter((u) => u.update.sessionUpdate === "agent_message_chunk").map((u) => (u.update as { content: { text: string } }).content.text).join("");

for (const target of targets) {
  const id = target.id;
  const model = `${id}/${target.info?.models.find((m) => m.default)?.id ?? "default"}`;

  describe(`${id}: bo acp live`, { skip: target.skip, timeout: 10 * LIVE_TIMEOUT }, () => {
    test("a prompt streams the answer and ends the turn; the session reopens after bo acp restarts", { timeout: 2 * LIVE_TIMEOUT }, async () => {
      const cwd = await workspace();
      const word = token("ACP");
      const first = await editor();
      try {
        const { sessionId } = await first.agent.newSession({ cwd, mcpServers: [] });
        await first.agent.setSessionConfigOption({ sessionId, configId: "model", value: model });
        const done = await first.agent.prompt({ sessionId, prompt: [{ type: "text", text: `Reply with exactly: ${word}` }] });
        assert.equal(done.stopReason, "end_turn");
        assert.ok(said(first.updates).includes(word), said(first.updates));
        assert.ok((done.usage?.inputTokens ?? 0) > 0, JSON.stringify(done.usage));
        first.stop();

        const second = await editor();
        try {
          await second.agent.loadSession({ sessionId, cwd, mcpServers: [] });
          assert.ok(said(second.updates).includes(word), "the reopened session shows its history");
          const again = await second.agent.prompt({ sessionId, prompt: [{ type: "text", text: "What exactly did you reply last time? Reply with only that." }] });
          assert.equal(again.stopReason, "end_turn");
          assert.ok(said(second.updates).split(word).length > 2, `the conversation continued: ${said(second.updates)}`);
        } finally {
          second.stop();
        }
      } finally {
        first.stop();
      }
    });

    test("an action outside the mode is a permission request; allowing it lets the agent do it", { timeout: LIVE_TIMEOUT }, async () => {
      const cwd = await workspace();
      const e = await editor();
      try {
        const { sessionId } = await e.agent.newSession({ cwd, mcpServers: [] });
        await e.agent.setSessionConfigOption({ sessionId, configId: "model", value: model });
        await e.agent.setSessionConfigOption({ sessionId, configId: "mode", value: "read" });
        const done = await e.agent.prompt({ sessionId, prompt: [{ type: "text", text: "Create the file b.txt containing ok." }] });
        assert.equal(done.stopReason, "end_turn");
        assert.ok(e.asked.length > 0, "the write was a permission request");
        assert.deepEqual(e.asked[0]!.options.map((o) => o.optionId), ["allow", "allow-run", "deny"]);
        assert.ok(existsSync(path.join(cwd, "b.txt")), "allowed, so the file exists");
      } finally {
        e.stop();
      }
    });
  });
}
