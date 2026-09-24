// Live /v1 integration: real server subprocess, real engine CLIs, real models. Every RunSpec axis and every run
// lifecycle path, asserted only through the public HTTP/SSE contract (plus the filesystem the agent touched).

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BoProblem } from "../../src/client.ts";
import type { StreamEvent } from "../../src/model.ts";
import { parseSse } from "../../src/client.ts";
import {
  FAKE_MCP, LIVE_TIMEOUT, MARKER_SKILL, RED_PNG, actions, describeRun, enginesUnderTest, pgrep, runToEnd,
  startBo, text, textOf, token, waitFor, workspace, type BoProcess,
} from "./harness.ts";

const server: BoProcess = await startBo();
after(async () => { await server.stop(); });
const targets = await enginesUnderTest(server.bo);

for (const target of targets) {
  const harness = target.id;
  const selection = { engine: harness };
  // The lightest effort the default model advertises (the knob is exercised; the model does not work hard).
  const efforts = target.info?.models.find((m) => m.default)?.efforts ?? [];
  const effort = efforts.length ? { effort: efforts[0]! } : {};

  describe(`${harness}: /v1 live`, { skip: target.skip, timeout: 60 * LIVE_TIMEOUT }, () => {
    test("text run: event order, deltas, usage, model, session", { timeout: LIVE_TIMEOUT }, async () => {
      const t = token("HELLO");
      const f = await runToEnd(server.bo, { input: text(`Reply with exactly: ${t}`), workspace: { root: await workspace() }, ...selection });
      assert.equal(f.run.status, "completed", describeRun(f));
      assert.ok(textOf(f.run).includes(t), describeRun(f));
      const logged = f.events.filter((e): e is Extract<StreamEvent, { id: number }> => "id" in e);
      assert.equal(logged[0]!.event, "run");
      assert.deepEqual(logged.map((e) => e.id), logged.map((_, i) => i + 1), "sequence is contiguous from 1");
      const last = logged.at(-1)!;
      assert.ok(last.event === "run" && last.data.status === "completed");
      assert.ok(f.events.some((e) => e.event === "delta"), "agent text streamed as deltas");
      const user = f.items.find((i) => i.type === "message" && i.role === "user");
      assert.ok(user, "input recorded as a user message item");
      assert.ok(f.items.some((i) => i.type === "message" && i.role === "agent" && i.status === "completed"));
      assert.match(f.run.session_id ?? "", /^ses_/);
      assert.ok(f.run.model, "model reported");
      assert.ok(f.run.usage.input_tokens > 0 && f.run.usage.output_tokens > 0, JSON.stringify(f.run.usage));
      assert.ok(f.run.ended_at && f.run.engine.id === harness);
      const again = await server.bo.runs.get(f.run.id);
      assert.equal(again.run.status, "completed", "GET /v1/runs/{id} returns the terminal run");
    });

    test("session: resume remembers, fork branches", { timeout: 3 * LIVE_TIMEOUT }, async () => {
      const root = await workspace();
      const secret = token("PAPAYA");
      const first = await runToEnd(server.bo, { input: text(`Remember this code word: ${secret}. Reply only with OK.`), workspace: { root }, ...selection });
      assert.equal(first.run.status, "completed", describeRun(first));
      const sid = first.run.session_id!;
      const resumed = await runToEnd(server.bo, { input: text("What was the code word? Reply with only the code word."), workspace: { root }, session: { id: sid } });
      assert.equal(resumed.run.status, "completed", describeRun(resumed));
      assert.ok(textOf(resumed.run).includes(secret), describeRun(resumed));
      assert.equal(resumed.run.session_id, sid, "resume keeps the session id");
      assert.equal(resumed.run.engine.id, harness, "the session decides the engine");
      const forked = await runToEnd(server.bo, { input: text("What was the code word? Reply with only the code word."), workspace: { root }, session: { id: sid, fork: true } });
      assert.equal(forked.run.status, "completed", describeRun(forked));
      assert.ok(textOf(forked.run).includes(secret), describeRun(forked));
      assert.notEqual(forked.run.session_id, sid, "fork gets a new session id");
    });

    test("structured output: result is a data part matching the schema", { timeout: LIVE_TIMEOUT }, async () => {
      const f = await runToEnd(server.bo, {
        input: text("Give the capital of France and its country code."),
        workspace: { root: await workspace() }, ...selection,
        output: { schema: { type: "object", properties: { capital: { type: "string" }, code: { type: "string" } }, required: ["capital", "code"], additionalProperties: false } },
      });
      assert.equal(f.run.status, "completed", describeRun(f));
      assert.equal(f.run.result?.kind, "data");
      const data = (f.run.result as { data: { capital: string; code: string } }).data;
      assert.match(data.capital, /paris/i);
      assert.match(data.code, /^FR/i);
    });

    test("tools: the agent reads the workspace and reports what it found", { timeout: LIVE_TIMEOUT }, async () => {
      const secret = token("CONTENT");
      const f = await runToEnd(server.bo, {
        input: text("Read notes/secret.txt and reply with its exact contents."),
        workspace: { root: await workspace({ "notes/secret.txt": `${secret}\n` }) }, ...selection, permissions: { access: "read" },
      });
      assert.equal(f.run.status, "completed", describeRun(f));
      assert.ok(textOf(f.run).includes(secret), describeRun(f));
      const used = actions(f.items).filter((a) => a.status === "completed" && (a.action.kind === "read" || a.action.kind === "shell" || a.action.kind === "search"));
      assert.ok(used.length > 0, `a completed read/shell action: ${describeRun(f)}`);
    });

    test("access write: writes inside the workspace, never outside", { timeout: LIVE_TIMEOUT }, async () => {
      const root = await workspace();
      const outside = path.join(root, "..", "escape.txt");
      const f = await runToEnd(server.bo, {
        input: text(`Create inside.txt containing ok. Then try to create ${outside} containing bad, and also run \`touch ${path.join(root, "..", "escape2.txt")}\`. Report what happened.`),
        workspace: { root }, ...selection, permissions: { access: "write" },
      });
      assert.ok(["completed", "failed"].includes(f.run.status), describeRun(f));
      assert.ok(existsSync(path.join(root, "inside.txt")), `inside.txt created: ${describeRun(f)}`);
      assert.ok(!existsSync(outside) && !existsSync(path.join(root, "..", "escape2.txt")), `nothing written outside: ${describeRun(f)}`);
    });

    test("edits carry diffs: a modified file's hunks, a deleted file's removed content", { timeout: LIVE_TIMEOUT }, async () => {
      const root = await workspace({ "a.txt": "one\ntwo\nthree\n", "c.txt": "gone\n" });
      const f = await runToEnd(server.bo, {
        input: text("In a.txt change the line two to TWO, and delete c.txt. Use your file editing tools, not the shell."),
        workspace: { root }, ...selection, permissions: { access: "write" },
      });
      assert.equal(f.run.status, "completed", describeRun(f));
      const changes = actions(f.items).filter((a) => a.status === "completed").flatMap((a) => (a.action.kind === "edit" ? a.action.changes : []));
      const a = changes.find((c) => c.path.endsWith("a.txt") && c.diff?.includes("+TWO"));
      assert.ok(a && a.diff!.includes("-two"), `a.txt diff: ${JSON.stringify(changes)}`);
      const c = changes.find((x) => x.path.endsWith("c.txt"));
      if (c) assert.match(c.diff ?? "", /^@@ .*\n-gone\n/, `c.txt delete diff: ${JSON.stringify(c)}`);
    });

    test("access write + extra_roots: the extra root is writable", { timeout: LIVE_TIMEOUT }, async () => {
      const root = await workspace();
      const extra = await mkdtemp(path.join(os.tmpdir(), "bo-it-extra-"));
      const f = await runToEnd(server.bo, {
        input: text(`Create the file ${path.join(extra, "d.txt")} containing ok.`),
        workspace: { root, extra_roots: [extra] }, ...selection, permissions: { access: "write" },
      });
      assert.ok(existsSync(path.join(extra, "d.txt")), describeRun(f));
    });

    test("access read, non-interactive: writes are denied, the run still completes", { timeout: LIVE_TIMEOUT }, async () => {
      const root = await workspace();
      const f = await runToEnd(server.bo, { input: text("Create b.txt containing ok."), workspace: { root }, ...selection, permissions: { access: "read" } });
      assert.equal(f.run.status, "completed", describeRun(f));
      assert.ok(!existsSync(path.join(root, "b.txt")), describeRun(f));
      assert.ok(!f.items.some((i) => i.type === "action" && i.status === "awaiting_approval"), "no approvals without interactive");
    });

    test("interactive approval: allow creates the file; the run waits while pending", { timeout: LIVE_TIMEOUT }, async () => {
      const root = await workspace();
      let sawWaiting = false;
      const f = await runToEnd(server.bo, { input: text("Create b.txt containing ok."), workspace: { root }, ...selection, permissions: { access: "read" }, interactive: true }, {
        onItem: async (item, h) => {
          if (item.type === "action" && item.status === "awaiting_approval") {
            sawWaiting = (await server.bo.runs.get(h.id)).run.status === "waiting";
            await h.respond(item.id, { decision: "allow" });
          }
        },
      });
      assert.equal(f.run.status, "completed", describeRun(f));
      assert.ok(sawWaiting, "run status was waiting while the approval was pending");
      assert.ok(existsSync(path.join(root, "b.txt")), describeRun(f));
    });

    test("interactive approval: deny keeps the file out and the run completes", { timeout: LIVE_TIMEOUT }, async (t) => {
      const root = await workspace();
      let asked = 0;
      const f = await runToEnd(server.bo, { input: text("Create b.txt containing ok. If you are not allowed, just say so."), workspace: { root }, ...selection, permissions: { access: "read" }, interactive: true }, {
        onItem: async (item, h) => {
          if (item.type === "action" && item.status === "awaiting_approval") { asked++; await h.respond(item.id, { decision: "deny" }); }
        },
      });
      assert.equal(f.run.status, "completed", describeRun(f));
      if (!asked) t.diagnostic(`${harness} declined to attempt the forbidden write without asking`);
      assert.ok(!existsSync(path.join(root, "b.txt")), describeRun(f));
    });

    test("interactive approval: allow_for_run covers later actions of the same kind", { timeout: LIVE_TIMEOUT }, async () => {
      const root = await workspace();
      let asked = 0;
      const f = await runToEnd(server.bo, {
        input: text("Using a separate shell command for each, run `touch one.txt`, then `touch two.txt`, then `touch three.txt`."),
        workspace: { root }, ...selection, permissions: { access: "read" }, interactive: true,
      }, {
        onItem: async (item, h) => {
          if (item.type === "action" && item.status === "awaiting_approval") { asked++; await h.respond(item.id, { decision: "allow_for_run" }); }
        },
      });
      assert.equal(f.run.status, "completed", describeRun(f));
      for (const n of ["one", "two", "three"]) assert.ok(existsSync(path.join(root, `${n}.txt`)), `${n}.txt: ${describeRun(f)}`);
      assert.ok(asked >= 1 && asked < 3, `allow_for_run should cover later actions (asked ${asked} times)`);
    });

    test("responding twice and responding with the wrong kind are problems", { timeout: LIVE_TIMEOUT }, async () => {
      const root = await workspace();
      const problems: string[] = [];
      await runToEnd(server.bo, { input: text("Create b.txt containing ok."), workspace: { root }, ...selection, permissions: { access: "read" }, interactive: true }, {
        onItem: async (item, h) => {
          if (item.type !== "action" || item.status !== "awaiting_approval") return;
          try { await h.respond(item.id, { answers: { x: ["y"] } }); } catch (e) { problems.push((e as BoProblem).problem.type); }
          await h.respond(item.id, { decision: "deny" });
          try { await h.respond(item.id, { decision: "allow" }); } catch (e) { problems.push((e as BoProblem).problem.type); }
        },
      });
      assert.ok(problems.length >= 2 && problems.length % 2 === 0, JSON.stringify(problems));
      for (let i = 0; i < problems.length; i += 2) assert.deepEqual(problems.slice(i, i + 2), [
        "urn:bo:problem:wrong_response_kind", "urn:bo:problem:item_not_awaiting",
      ]);
    });

    test("questions: the agent asks, the caller answers", { timeout: LIVE_TIMEOUT }, async () => {
      const root = await workspace();
      const f = await runToEnd(server.bo, {
        input: text("Ask me which color I prefer (red or blue) using your question tool, then write only my answer to color.txt."),
        workspace: { root }, ...selection, interactive: true,
      }, {
        onItem: async (item, h) => {
          if (item.type === "question" && item.status === "awaiting_answer") {
            await h.respond(item.id, { answers: Object.fromEntries(item.questions.map((q) => [q.id, [q.options?.find((o) => /blue/i.test(o)) ?? "blue"]])) });
          }
        },
      });
      assert.ok(f.items.some((i) => i.type === "question" && i.status === "answered"), describeRun(f));
      assert.match(readFileSync(path.join(root, "color.txt"), "utf8"), /blue/i);
    });

    test("questions without a caller are declined and the agent proceeds", { timeout: LIVE_TIMEOUT }, async () => {
      const f = await runToEnd(server.bo, {
        input: text("Ask me which color I prefer using your question tool. If nobody answers, reply with exactly: NO-ANSWER"),
        workspace: { root: await workspace() }, ...selection,
      });
      assert.equal(f.run.status, "completed", describeRun(f));
      assert.ok(!f.items.some((i) => i.type === "question" && i.status === "awaiting_answer"), "no pending question without interactive");
    });

    test("steer: a message mid-run changes what the agent does", { timeout: LIVE_TIMEOUT }, async () => {
      const root = await workspace();
      const f = await runToEnd(server.bo, {
        input: text("Run the shell command `sleep 8`, then reply with exactly: PLAIN. Follow any new instructions I send."),
        workspace: { root }, ...selection, permissions: { access: "write" },
      }, {
        onStart: (h) => { setTimeout(() => { void h.message("New instruction: reply with exactly STEERED instead of PLAIN.").catch(() => undefined); }, 3000); },
      });
      assert.equal(f.run.status, "completed", describeRun(f));
      assert.match(textOf(f.run), /STEERED/, describeRun(f));
      assert.ok(f.items.filter((i) => i.type === "message" && i.role === "user").length >= 2, "steering message recorded as a user item");
    });

    test("cancel: the run ends cancelled and the engine process tree is gone", { timeout: LIVE_TIMEOUT }, async () => {
      const marker = `sleep ${600 + Math.floor(Math.random() * 300)}`;
      const f = await runToEnd(server.bo, { input: text(`Run the shell command \`${marker}\` and wait for it.`), workspace: { root: await workspace() }, ...selection, permissions: { access: "full" } }, {
        onItem: (item, h) => {
          if (item.type === "action" && item.action.kind === "shell" && item.status === "running") void h.cancel();
        },
      });
      assert.equal(f.run.status, "cancelled", describeRun(f));
      assert.equal(f.run.result, undefined);
      assert.ok(await waitFor(() => pgrep(marker).length === 0, 15_000), `${marker} still running: ${pgrep(marker)}`);
    });

    test("timeout_s fails the run with code timeout and kills the tree", { timeout: LIVE_TIMEOUT }, async () => {
      const marker = `sleep ${300 + Math.floor(Math.random() * 90)}`;
      const started = Date.now();
      const f = await runToEnd(server.bo, {
        input: text(`Run the shell command \`${marker}\` in the foreground and wait for it to finish.`),
        workspace: { root: await workspace() }, ...selection, permissions: { access: "full" }, timeout_s: 1,
      });
      assert.equal(f.run.status, "failed", describeRun(f));
      assert.equal(f.run.error?.code, "timeout");
      assert.ok(Date.now() - started < 40_000, `timeout fired late: ${Date.now() - started}ms`);
      assert.ok(await waitFor(() => pgrep(marker).length === 0, 15_000), `${marker} still running`);
    });

    test("a completed run leaves no process behind, even background ones", { timeout: LIVE_TIMEOUT }, async () => {
      const marker = `sleep ${1600 + Math.floor(Math.random() * 90)}`;
      const f = await runToEnd(server.bo, {
        input: text(`Start the shell command \`${marker}\` in the background (do not wait for it), then reply with exactly: STARTED`),
        workspace: { root: await workspace() }, ...selection, permissions: { access: "full" },
      });
      assert.equal(f.run.status, "completed", describeRun(f));
      assert.ok(await waitFor(() => pgrep(marker).length === 0, 15_000), `${marker} outlived its run: ${pgrep(marker)}`);
    });

    test("reconnect: Last-Event-ID resumes without gaps or duplicates", { timeout: LIVE_TIMEOUT }, async () => {
      const handle = await server.bo.run({ input: text("Count from 1 to 5, one per line, then say DONE."), workspace: { root: await workspace() }, ...selection });
      const first: StreamEvent[] = [];
      const ac = new AbortController();
      const res = await fetch(`${server.url}/v1/runs/${handle.id}/events`, { signal: ac.signal });
      try {
        for await (const e of parseSse(res.body!)) { first.push(e); if (first.filter((x) => "id" in x).length >= 3) break; }
      } finally { ac.abort(); }
      const lastId = Math.max(...first.filter((e) => "id" in e).map((e) => (e as { id: number }).id));
      const rest: StreamEvent[] = [];
      for await (const e of handle.events({ after: lastId })) rest.push(e);
      const ids = [...first, ...rest].filter((e) => "id" in e).map((e) => (e as { id: number }).id);
      assert.deepEqual(ids, ids.map((_, i) => i + 1), "ids contiguous across the reconnect");
      assert.ok(rest.at(-1)!.event === "run" && TERMINAL_OK(rest.at(-1)!));
    });

    test("disconnecting never cancels the run", { timeout: LIVE_TIMEOUT }, async () => {
      const t = token("DETACHED");
      const handle = await server.bo.run({ input: text(`Reply with exactly: ${t}`), workspace: { root: await workspace() }, ...selection });
      const ac = new AbortController();
      const res = await fetch(`${server.url}/v1/runs/${handle.id}/events`, { signal: ac.signal });
      ac.abort();
      void res.body?.cancel().catch(() => undefined);
      assert.ok(await waitFor(async () => (await server.bo.runs.get(handle.id)).run.status === "completed", LIVE_TIMEOUT - 30_000, 1000));
      assert.ok(textOf((await server.bo.runs.get(handle.id)).run).includes(t));
    });

    test("input parts: image and structured data", { timeout: 2 * LIVE_TIMEOUT }, async () => {
      const img = await runToEnd(server.bo, {
        input: [...text("What single color fills this image? Answer with one word."), { kind: "image", path: RED_PNG, media_type: "image/png" }],
        workspace: { root: await workspace() }, ...selection,
      });
      assert.equal(img.run.status, "completed", describeRun(img));
      assert.match(textOf(img.run), /red/i);
      const t = token("DATA");
      const data = await runToEnd(server.bo, {
        input: [...text("What is the value of `marker` in the structured input? Reply with only the value."), { kind: "data", data: { marker: t, noise: [1, 2, 3] } }],
        workspace: { root: await workspace() }, ...selection,
      });
      assert.ok(textOf(data.run).includes(t), describeRun(data));
    });

    test("instructions are applied on top of the engine prompt", { timeout: LIVE_TIMEOUT }, async () => {
      const t = token("SIGNOFF");
      const f = await runToEnd(server.bo, {
        input: text("Say hello."), workspace: { root: await workspace() },
        ...selection, instructions: `End every reply with the exact word ${t}.`,
      });
      assert.ok(textOf(f.run).includes(t), describeRun(f));
    });

    test("project instructions: AGENTS.md applies by default, never the workspace's engine config", { timeout: 2 * LIVE_TIMEOUT }, async () => {
      const t = token("TRAILER");
      const root = await workspace({
        "AGENTS.md": `End every reply with the exact word ${t}.\n`,
        // A workspace-level codex config must never load: bo runs keep the workspace untrusted.
        ".codex/config.toml": `[mcp_servers.leak]\ncommand = "${process.execPath}"\nargs = ["${FAKE_MCP}"]\n`,
      });
      const on = await runToEnd(server.bo, { input: text("Say hello."), workspace: { root }, ...selection, permissions: { access: "write" } });
      assert.equal(on.run.status, "completed", describeRun(on));
      assert.ok(textOf(on.run).includes(t), describeRun(on));
      assert.ok(!actions(on.items).some((a) => a.action.kind === "mcp"), describeRun(on));
      assert.ok(!existsSync(path.join(server.stateHome, "bo", "codex", "config.toml")),
        "codex persisted no project trust into bo's CODEX_HOME");
      const off = await runToEnd(server.bo, { input: text("Say hello."), workspace: { root }, ...selection, project_instructions: false });
      assert.equal(off.run.status, "completed", describeRun(off));
      assert.ok(!textOf(off.run).includes(t), describeRun(off));
    });

    test("limits: max_turns stops a multi-step run with limit_exceeded", { timeout: LIVE_TIMEOUT }, async () => {
      const f = await runToEnd(server.bo, {
        input: text("Create a.txt, then b.txt, then c.txt, each with its own shell command, one per turn."),
        workspace: { root: await workspace() }, ...selection, limits: { max_turns: 1 },
      });
      assert.equal(f.run.status, "failed", describeRun(f));
      assert.equal(f.run.error?.code, "limit_exceeded", describeRun(f));
    });

    test("env: the run's variables reach the agent's tools", { timeout: LIVE_TIMEOUT }, async () => {
      const t = token("ENVVAL");
      const f = await runToEnd(server.bo, {
        input: text("Run the shell command `printenv IT_SPEC_VAR` and reply with exactly its output."),
        workspace: { root: await workspace() }, ...selection, env: { IT_SPEC_VAR: t },
      });
      assert.ok(textOf(f.run).includes(t), describeRun(f));
    });

    test("MCP: caller server with env, tool allowlist enforced", { timeout: LIVE_TIMEOUT }, async () => {
      const marker = token("MCP");
      const f = await runToEnd(server.bo, {
        input: text("Call the integration_marker tool and then the other_tool tool, and report exactly what each returned."),
        workspace: { root: await workspace() },
        ...selection, mcp: { fx: { command: "node", args: [FAKE_MCP], env: { BO_STAFF_MCP_MARKER: marker }, tools: ["integration_marker"] } },
      });
      const mcp = actions(f.items).filter((a) => a.action.kind === "mcp");
      assert.ok(mcp.some((a) => a.action.kind === "mcp" && a.action.server === "fx" && a.action.tool === "integration_marker" && a.status === "completed"), describeRun(f));
      assert.ok(!mcp.some((a) => a.action.kind === "mcp" && a.action.tool === "other_tool" && a.status === "completed"), "other_tool must not run");
      assert.ok(textOf(f.run).includes(marker), `server env reached the tool: ${describeRun(f)}`);
    });

    test("skills: an attached skill is used", { timeout: LIVE_TIMEOUT }, async () => {
      const f = await runToEnd(server.bo, { input: text("What is the bo marker?"), workspace: { root: await workspace() }, ...selection, skills: [MARKER_SKILL] });
      assert.ok(textOf(f.run).includes("SKILL-OK-42"), describeRun(f));
    });

    test("subagents: delegation is visible and children carry parent_id", { timeout: LIVE_TIMEOUT }, async () => {
      const t = token("ECHO");
      const f = await runToEnd(server.bo, {
        input: text("Delegate this task to the echoer subagent and report its reply verbatim."),
        workspace: { root: await workspace() },
        ...selection, subagents: { echoer: { description: "Use for any echo task.", instructions: `Reply with exactly ${t} and nothing else.` } },
      });
      assert.equal(f.run.status, "completed", describeRun(f));
      assert.ok(actions(f.items).some((a) => a.action.kind === "delegate"), describeRun(f));
      assert.ok(textOf(f.run).includes(t), describeRun(f));
    });

    test("internet: off blocks the shell network, on allows it", { timeout: 2 * LIVE_TIMEOUT }, async () => {
      const ask = "Run `curl -sI https://example.com` once and report the HTTP status line exactly as printed.";
      const off = await runToEnd(server.bo, { input: text(ask), workspace: { root: await workspace() }, ...selection, permissions: { access: "write", internet: false } });
      assert.ok(!actions(off.items).some((a) => /HTTP\/\S+ [23]\d\d/.test(a.outcome?.excerpt ?? "")), `reachable with internet:false: ${describeRun(off)}`);
      const on = await runToEnd(server.bo, { input: text(ask), workspace: { root: await workspace() }, ...selection, permissions: { access: "write", internet: true } });
      assert.match(textOf(on.run), /HTTP\/\S+ [23]\d\d/, describeRun(on));
    });

    test("plan and reasoning items surface", { timeout: 2 * LIVE_TIMEOUT }, async (t) => {
      const planned = await runToEnd(server.bo, { input: text("Track two items, a and b, with your task/todo tool, mark both done, then reply DONE."), workspace: { root: await workspace() }, ...selection });
      assert.ok(planned.items.some((i) => i.type === "plan" && i.steps.length >= 2), describeRun(planned));
      const f = await runToEnd(server.bo, {
        input: text("What is 12 + 30? Reply with just the number."),
        workspace: { root: await workspace() }, ...selection, ...effort,
      });
      if (!f.items.some((i) => i.type === "reasoning" && i.text.trim())) t.diagnostic(`${harness} emitted no reasoning item for this turn`);
      assert.match(textOf(f.run), /\b42\b/);
    });

    test("idempotency, session_busy and parallel runs", { timeout: 2 * LIVE_TIMEOUT }, async () => {
      const root = await workspace();
      const spec = { input: text(`Reply with exactly: ${token("IDEM")}`), workspace: { root }, ...selection };
      const a = await server.bo.run(spec, { idempotencyKey: "it-key-" + token("K") });
      const key = "it-" + token("K");
      const b1 = await server.bo.run(spec, { idempotencyKey: key });
      const b2 = await server.bo.run(spec, { idempotencyKey: key });
      assert.equal(b1.id, b2.id, "same key, same run");
      await assert.rejects(server.bo.run({ ...spec, interactive: true }, { idempotencyKey: key }), (e: unknown) => (e as BoProblem).problem?.type === "urn:bo:problem:idempotency_mismatch");
      const [ra, rb] = await Promise.all([a.done(), b1.done()]);
      assert.equal(ra.status, "completed");
      assert.equal(rb.status, "completed");

      const s = ra.session_id!;
      const slow = await server.bo.run({ input: text("Run `sleep 20` and then reply DONE."), workspace: { root }, session: { id: s }, permissions: { access: "full" } });
      await assert.rejects(server.bo.run({ input: text("hi"), workspace: { root }, session: { id: s } }), (e: unknown) => (e as BoProblem).problem?.type === "urn:bo:problem:session_busy");
      await slow.cancel();
      await slow.done();
    });
  });
}

function TERMINAL_OK(e: StreamEvent): boolean {
  return e.event === "run" && ["completed", "failed", "cancelled"].includes(e.data.status);
}

test("problems are enforced by the live server before any model call", async () => {
  const root = await workspace();
  const bad = async (spec: unknown, type: string) => {
    const res = await fetch(`${server.url}/v1/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(spec) });
    const p = await res.json() as { type: string };
    assert.equal(p.type, `urn:bo:problem:${type}`, JSON.stringify(p));
  };
  await bad({ input: [], workspace: { root } }, "invalid_spec");
  await bad({ input: text("x"), workspace: { root }, surprise: 1 }, "invalid_spec");
  await bad({ input: text("x"), workspace: { root }, session: { id: "ses_bogus" } }, "invalid_spec");
  await bad({ input: text("x"), workspace: { root }, permissions: { access: "full", internet: false } }, "invalid_spec");
  await bad({ input: text("x"), workspace: { root }, skills: [root] }, "invalid_spec");
  await bad({ input: text("x"), workspace: { root }, agent: { skills: [] } }, "invalid_spec");
  const fetchJson = await fetch(`${server.url}/v1/runs`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
  assert.equal(fetchJson.status, 415);
});
