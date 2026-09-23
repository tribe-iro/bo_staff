import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { PassThrough } from "node:stream";
import { Bo, BoProblem, expand } from "../src/client.ts";
import { main } from "../src/cli.ts";
import { startServer, type BoServer } from "../src/http/server.ts";
import type { Outcome, RunIO } from "../src/harness/port.ts";
import type { ResolvedSpec } from "../src/spec.ts";
import { ok, scripted, tmpdir } from "./helpers.ts";

// The CLI reads $XDG_CONFIG_HOME/bo/config.toml: never the operator's in tests.
process.env.XDG_CONFIG_HOME = await tmpdir();

const servers: BoServer[] = [];
after(async () => { await Promise.all(servers.map((s) => s.close())); });

async function boot(script: (s: unknown, io: RunIO) => Promise<Outcome>) {
  const s = await startServer({ port: 0, env: { PATH: process.env.PATH ?? "" }, engines: [scripted("claude-code", script)], sessionsFile: null });
  servers.push(s);
  return s;
}

test("expand turns sugar into the canonical wire shape", () => {
  assert.deepEqual(expand({ input: "hi", workspace: "/w" }), { input: [{ kind: "text", text: "hi" }], workspace: { root: "/w" } });
  const canonical = { input: [{ kind: "text" as const, text: "x" }], workspace: { root: "/w" } };
  assert.deepEqual(expand(canonical), canonical);
  const rich = {
    input: "work", workspace: "/w", engine: "codex" as const, model: "m", effort: "high" as const,
    instructions: "i", skills: ["/s"], mcp: { x: { url: "https://example.com" } },
    subagents: { reviewer: { description: "d", instructions: "i" } }, timeout_s: 7,
  };
  assert.deepEqual(expand(rich), { ...rich, input: [{ kind: "text", text: "work" }], workspace: { root: "/w" } });
});

test("create → done, with onItem answering approvals", async () => {
  const s = await boot(async (_s, io) => {
    io.session("s1");
    const r = await io.await("a", { type: "action", action: { kind: "shell", command: "ls" }, status: "awaiting_approval" });
    return ok(r && "decision" in r ? r.decision : "none");
  });
  const bo = new Bo({ url: s.url });
  const handle = await bo.run({ input: "go", workspace: await tmpdir(), interactive: true });
  const run = await handle.done({
    onItem: async (item, h) => {
      if (item.type === "action" && item.status === "awaiting_approval") await h.respond(item.id, { decision: "allow_for_run" });
    },
  });
  assert.equal(run.status, "completed");
  assert.deepEqual(run.result, { kind: "text", text: "allow_for_run" });
  assert.ok(run.session_id?.startsWith("ses_"));
  assert.equal((await bo.runs.list()).length, 1);
  assert.equal((await bo.engines())[0]!.id, "claude-code");
});

test("problems surface as BoProblem; refused connections explain themselves", async () => {
  const s = await boot(async () => ok());
  const bo = new Bo({ url: s.url });
  await assert.rejects(bo.run({ input: "x", workspace: "relative" }), (e: unknown) => e instanceof BoProblem && e.problem.type.endsWith("invalid_spec"));
  const free = await new Promise<number>((resolve) => {
    const srv = createServer().listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
  await assert.rejects(new Bo({ url: `http://127.0.0.1:${free}` }).engines(), /no bo server at .*start one with `bo serve`/);
  const proxy = createHttpServer((_req, res) => res.writeHead(502, { "content-type": "text/html" }).end("<html>bad gateway</html>")).listen(0, "127.0.0.1");
  await new Promise((r) => proxy.once("listening", r));
  try {
    await assert.rejects(new Bo({ url: `http://127.0.0.1:${(proxy.address() as { port: number }).port}` }).engines(),
      (e: unknown) => e instanceof Error && !(e instanceof SyntaxError) && e.message === "502 <html>bad gateway</html>");
  } finally {
    proxy.close();
  }
});

test("cli: --help is only a command position", async () => {
  const io = () => {
    const text: string[] = [];
    const out = new PassThrough();
    const err = new PassThrough();
    out.on("data", (c: Buffer) => text.push(c.toString()));
    err.on("data", (c: Buffer) => text.push(c.toString()));
    return { text, io: { out, err, in: Object.assign(new PassThrough(), { isTTY: false }) } };
  };
  for (const argv of [["--help"], ["-h"], ["help"], ["run", "--help"]]) {
    const t = io();
    assert.equal(await main(argv, t.io), 0, argv.join(" "));
    assert.match(t.text.join(""), /\nusage:\n  bo run/);
  }
  const t = io();
  assert.equal(await main(["run", "explain", "--help", "flag"], t.io), 2);
  assert.match(t.text.join(""), /^bo: unknown flag --help\n  `bo --help` lists every command and flag\n$/, "a prompt word is parsed as a run argument, not a help request");
});

test("engine diagnostics and configured secrets never enter CLI output", async () => {
  const secret = "SECRET-MCP-TOKEN-91";
  const s = await boot(async () => ({
    ok: false,
    error: { code: "engine_error", message: "engine execution failed" },
    usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
    diagnostic: { stderr: secret, headers: { authorization: `Bearer ${secret}` } },
  }));
  const out = new PassThrough();
  const err = new PassThrough();
  const input = Object.assign(new PassThrough(), { isTTY: false });
  const chunks: string[] = [];
  out.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  err.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  input.end();
  assert.equal(await main(["run", "--json", "--url", s.url, "--workspace", await tmpdir(), "fail"], { out, err, in: input }), 1);
  assert.doesNotMatch(chunks.join(""), /SECRET-MCP-TOKEN-91|authorization/i);
});

test("cli: --json run prints NDJSON ending in a terminal run; runs lists runs", async () => {
  const s = await boot(async (_s, io) => {
    io.upsert("m", { type: "message", role: "agent", content: [{ kind: "text", text: "hey" }], status: "completed" });
    return ok("hey");
  });
  const out = new PassThrough();
  const err = new PassThrough();
  const input = Object.assign(new PassThrough(), { isTTY: false });
  const chunks: string[] = [];
  out.on("data", (c: Buffer) => chunks.push(c.toString()));
  const code = await main(["run", "--json", "--url", s.url, "--workspace", await tmpdir(), "hi"], { out, err, in: input });
  assert.equal(code, 0);
  const lines = chunks.join("").trim().split("\n").map((l) => JSON.parse(l) as { event: string; data: { status?: string } });
  assert.equal(lines.at(-1)!.event, "run");
  assert.equal(lines.at(-1)!.data.status, "completed");

  for (const argv of [["runs", "--url", s.url]]) {
    const ps: string[] = [];
    const out2 = new PassThrough();
    out2.on("data", (c: Buffer) => ps.push(c.toString()));
    assert.equal(await main(argv, { out: out2, err, in: input }), 0, `global flags anywhere: ${argv.join(" ")}`);
    assert.match(ps.join(""), /run_[0-9a-f]+\s+completed/);
  }

  const usage = new PassThrough();
  const usageText: string[] = [];
  usage.on("data", (c: Buffer) => usageText.push(c.toString()));
  assert.equal(await main(["run", "--url", s.url, "--bogus", "x"], { out, err: usage, in: input }), 2);
  assert.match(usageText.join(""), /unknown flag --bogus/);
});

test("cli: interactive approval answered from stdin", async () => {
  const s = await boot(async (_s, io) => {
    const r = await io.await("a", { type: "action", action: { kind: "shell", command: "rm x" }, status: "awaiting_approval" });
    return ok(r && "decision" in r ? r.decision : "none");
  });
  const out = new PassThrough();
  const err = new PassThrough();
  const input = Object.assign(new PassThrough(), { isTTY: true });
  Object.assign(err, { isTTY: true });
  const text: string[] = [];
  out.on("data", (c: Buffer) => text.push(c.toString()));
  err.on("data", (c: Buffer) => { if (c.toString().includes("[y] yes")) input.write("y\n"); });
  const code = await main(["run", "--url", s.url, "--workspace", await tmpdir(), "do it"], { out, err, in: input });
  assert.equal(code, 0);
  assert.match(text.join(""), /allow/);
});

test("cli substitutes one stdin placeholder in argument order", async () => {
  let received: ResolvedSpec | undefined;
  const s = await boot(async (spec) => { received = spec as ResolvedSpec; return ok(); });
  const input = Object.assign(new PassThrough(), { isTTY: false });
  input.end("DIFF");
  const code = await main(["run", "--url", s.url, "--workspace", await tmpdir(), "review", "-", "carefully"], {
    in: input, out: new PassThrough(), err: new PassThrough(),
  });
  assert.equal(code, 0);
  assert.deepEqual(received?.input, [{ kind: "text", text: "review DIFF carefully" }]);
});

test("cli: --env, --max-turns, --max-tokens and --no-project-instructions map onto the spec", async () => {
  let received: ResolvedSpec | undefined;
  const s = await boot(async (spec) => { received = spec as ResolvedSpec; return ok(); });
  const root = await tmpdir();
  await import("node:fs/promises").then((fs) => fs.writeFile(`${root}/AGENTS.md`, "house rules"));
  const input = Object.assign(new PassThrough(), { isTTY: false });
  assert.equal(await main(["run", "--url", s.url, "--env", "NOEQUALS", "x"], { in: input, out: new PassThrough(), err: new PassThrough() }), 2);
  const code = await main([
    "run", "--url", s.url, "--workspace", root, "--env", "A=1=2", "--env", "B=", "--max-turns", "3", "--max-tokens", "50000",
    "--no-project-instructions", "go",
  ], { in: input, out: new PassThrough(), err: new PassThrough() });
  assert.equal(code, 0);
  assert.deepEqual(received?.env, { A: "1=2", B: "" });
  assert.deepEqual(received?.limits, { maxTurns: 3, maxTokens: 50_000 });
  assert.equal(received?.instructions, undefined, "AGENTS.md skipped");
});

test("cli: on one terminal the streamed answer is not printed twice; piped stdout still gets it", async () => {
  const s = await boot(async (_spec, io) => {
    io.upsert("m", { type: "message", role: "agent", content: [{ kind: "text", text: "Good morning!" }], status: "completed" });
    return ok("Good morning!");
  });
  const run = async (tty: boolean) => {
    const out = Object.assign(new PassThrough(), { isTTY: tty });
    const err = Object.assign(new PassThrough(), { isTTY: tty });
    let printed = "";
    let progress = "";
    out.on("data", (c: Buffer) => { printed += c.toString(); });
    err.on("data", (c: Buffer) => { progress += c.toString(); });
    const input = Object.assign(new PassThrough(), { isTTY: false });
    assert.equal(await main(["run", "--url", s.url, "--workspace", await tmpdir(), "hi"], { in: input, out, err }), 0);
    return { printed, progress };
  };
  const terminal = await run(true);
  assert.equal(terminal.printed, "Good morning!\n", "on a terminal the agent's words are the answer, shown once");
  assert.doesNotMatch(terminal.progress, /Good morning/);
  const piped = await run(false);
  assert.deepEqual(piped, { printed: "Good morning!\n", progress: "" }, "piped: the answer, and nothing else");
});

test("cli: -c continues this directory's latest session; bo sessions lists it; -c with --session is a usage error", async () => {
  const seen: (string | undefined)[] = [];
  const s = await boot(async (spec, io) => {
    const r = spec as ResolvedSpec;
    seen.push(r.session?.native);
    io.session(r.session?.native ?? "native-1");
    return ok();
  });
  const root = await tmpdir();
  const quiet = () => ({ in: Object.assign(new PassThrough(), { isTTY: false }), out: new PassThrough(), err: new PassThrough() });
  assert.equal(await main(["run", "--url", s.url, "--workspace", root, "first task"], quiet()), 0);
  assert.equal(await main(["run", "--url", s.url, "--workspace", root, "-c", "follow up"], quiet()), 0);
  assert.deepEqual(seen, [undefined, "native-1"]);
  const listing = quiet();
  let text = "";
  listing.out.on("data", (c: Buffer) => { text += c.toString(); });
  assert.equal(await main(["sessions", "--url", s.url, "--workspace", root], listing), 0);
  assert.match(text, /^session\s+engine\s+model\s+runs\s+last used\s+id\nfirst task\s+claude-code\s+–\s+2\s/);
  assert.match(text, /bo run -c continues the newest/);
  const err = quiet();
  let problem = "";
  err.err.on("data", (c: Buffer) => { problem += c.toString(); });
  assert.equal(await main(["run", "--url", s.url, "-c", "--session", "ses_x", "x"], err), 2);
  assert.match(problem, /use either -c \(latest session here\) or --session <id>, not both/);
});

test("cli: config.toml supplies defaults (new sessions only for engine/model/effort); bo config shows sources", async () => {
  const received: ResolvedSpec[] = [];
  const s = await boot(async (spec, io) => { received.push(spec as ResolvedSpec); io.session("n"); return ok(); });
  const home = await tmpdir();
  await import("node:fs/promises").then(async (fs) => {
    await fs.mkdir(`${home}/bo`);
    await fs.writeFile(`${home}/bo/config.toml`, `url = "${s.url}"\n[run]\naccess = "read"\neffort = "high"\n`);
  });
  const env = { ...process.env, XDG_CONFIG_HOME: home };
  const io = () => ({ in: Object.assign(new PassThrough(), { isTTY: false }), out: new PassThrough(), err: new PassThrough() });
  const root = await tmpdir();
  assert.equal(await main(["run", "--workspace", root, "hi"], io(), env), 0, "the url comes from config.toml");
  assert.equal(received[0]!.access, "read");
  assert.equal(received[0]!.effort, "high");
  assert.equal(await main(["run", "--workspace", root, "-c", "again"], io(), env), 0);
  assert.equal(received[1]!.effort, undefined, "a continued session keeps its own settings");
  assert.equal(received[1]!.access, "read", "access applies to every run");
  const shown = io();
  let text = "";
  shown.out.on("data", (c: Buffer) => { text += c.toString(); });
  assert.equal(await main(["config"], shown, { ...env, BO_TOKEN: "t" }), 0);
  assert.match(text, new RegExp(`config ${home}/bo/config.toml\\n`));
  assert.match(text, /run\.access\s+read\s+config\.toml/);
  assert.match(text, /serve\.port\s+3000\s+default/);
  assert.match(text, /token\s+set\s+env BO_TOKEN/);
  assert.doesNotMatch(text, /\bt\b.*BO_TOKEN.*\bt\b/, "the token value is never printed");
  await import("node:fs/promises").then((fs) => fs.writeFile(`${home}/bo/config.toml`, "[run]\nverbos = 1\n"));
  const bad = io();
  let problem = "";
  bad.err.on("data", (c: Buffer) => { problem += c.toString(); });
  assert.equal(await main(["runs"], bad, env), 2);
  assert.match(problem, /^bo: .*config\.toml: unknown key run\.verbos\n  `bo config` shows every setting and its source\n$/);
});
