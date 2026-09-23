// Live conformance suite: runs scenarios C1–C23 through the real adapters, records native transcripts via the
// tap under ignored test/transcripts/, writes translator results next to them, and prints PASS/FAIL per scenario.
// Review recordings before copying any into the committed replay fixtures under test/fixtures/transcripts/.
//
//   node scripts/conformance.ts [claude-code|codex] [C#…]
//
// Uses the operator's credentials. Subscription logins require BO_ALLOW_SUBSCRIPTION_AUTH=1 (personal use only).

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { RunManager } from "../src/core/runs.ts";
import { SessionIndex } from "../src/core/sessions.ts";
import { createClaudeCode } from "../src/harness/claude-code/index.ts";
import { createCodex } from "../src/harness/codex/index.ts";
import { createTranscriptRecorder } from "../test/tap.ts";
import type { Harness } from "../src/harness/port.ts";
import { ENGINE_IDS, TERMINAL, type EngineId, type EngineInfo, type Item, type Run, type RunSpec } from "../src/model.ts";
import { isProblem } from "../src/problems.ts";
import { resolveSpec } from "../src/spec.ts";
import { replayTranscript } from "../test/replay.ts";
import { fixedCatalog } from "../test/helpers.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const TRANSCRIPTS = path.join(ROOT, "test", "transcripts");
const FIXTURES = path.join(ROOT, "test", "fixtures");
const RED_PNG = path.join(FIXTURES, "red.png");
const MARKER_SKILL = path.join(FIXTURES, "skills", "marker");
const FAKE_MCP = path.join(ROOT, "test", "fake", "mcp-server.mjs");

interface Ctx { scratch: string; sessions: Map<string, string> }
interface Outcome { run: Run; items: Item[] }
interface Scenario {
  id: string;
  spec(ctx: Ctx): RunSpec | Promise<RunSpec>;
  env?: Record<string, string>;
  /** Called on every item event; may respond or steer via the manager. */
  drive?(item: Item, api: { respond: RunManager["respond"]; message: RunManager["message"]; cancel: RunManager["cancel"]; runId: string }): void;
  after?(api: { message: RunManager["message"]; cancel: RunManager["cancel"]; runId: string }): void;
  check(o: Outcome, ctx: Ctx): string | undefined;   // undefined = PASS, otherwise the failure reason
}

const text = (t: string) => [{ kind: "text" as const, text: t }];
const resultText = (r: Run) => (r.result?.kind === "text" ? r.result.text : r.result?.kind === "data" ? JSON.stringify(r.result.data) : "");
const expect = (cond: boolean, why: string) => (cond ? undefined : why);
const completed = (o: Outcome) => expect(o.run.status === "completed", `status ${o.run.status}${o.run.error ? ` (${o.run.error.code}: ${o.run.error.message})` : ""}`);
const all = (...checks: (string | undefined)[]) => checks.find(Boolean);
const actions = (o: Outcome) => o.items.filter((i): i is Extract<Item, { type: "action" }> => i.type === "action");

const SCENARIOS: Scenario[] = [
  { id: "C1", spec: (c) => ({ input: text("say hi"), workspace: { root: c.scratch }, permissions: { access: "full" } }),
    check: (o, c) => { c.sessions.set("C1", o.run.session_id ?? ""); return all(completed(o), expect(resultText(o.run).trim().length > 0, "empty result")); } },
  { id: "C2", spec: (c) => ({ input: text("read a.txt and summarize it"), workspace: { root: c.scratch } }),
    check: (o) => all(completed(o), expect(actions(o).some((a) => a.status === "completed" && (a.action.kind === "read" || a.action.kind === "shell")), "no completed read/shell action"), expect(/hello/i.test(resultText(o.run)), "result does not mention hello")) },
  { id: "C3", spec: (c) => ({ input: text("What is the capital of France?"), workspace: { root: c.scratch },
    output: { schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false } } }),
    check: (o) => all(completed(o), expect(o.run.result?.kind === "data" && typeof (o.run.result.data as { answer?: unknown }).answer === "string", "no data.answer")) },
  { id: "C4", spec: (c) => ({ input: text("what did you say?"), workspace: { root: c.scratch }, session: { id: c.sessions.get("C1")! } }),
    check: (o, c) => all(completed(o), expect(o.run.session_id === c.sessions.get("C1"), "session id changed")) },
  { id: "C5", spec: (c) => ({ input: text("repeat your first answer"), workspace: { root: c.scratch }, session: { id: c.sessions.get("C1")!, fork: true } }),
    check: (o, c) => all(completed(o), expect(!!o.run.session_id && o.run.session_id !== c.sessions.get("C1"), "fork kept the session id")) },
  { id: "C6", spec: (c) => ({ input: text("Create inside.txt containing ok, create ../outside.txt containing ok, then run `touch ../outside2.txt`."), workspace: { root: c.scratch }, permissions: { access: "write" } }),
    check: (_o, c) => all(expect(existsSync(path.join(c.scratch, "inside.txt")), "inside.txt missing"),
      expect(!existsSync(path.join(c.scratch, "..", "outside.txt")) && !existsSync(path.join(c.scratch, "..", "outside2.txt")), "wrote outside the workspace")) },
  { id: "C7", spec: (c) => ({ input: text("Run `ls`, then run `touch x.txt`."), workspace: { root: c.scratch }, permissions: { access: "read" } }),
    check: (o, c) => all(completed(o), expect(!existsSync(path.join(c.scratch, "x.txt")), "x.txt was created")) },
  { id: "C8", spec: (c) => ({ input: text("Create b.txt containing ok."), workspace: { root: c.scratch }, permissions: { access: "read" }, interactive: true }),
    drive: (i, api) => { if (i.type === "action" && i.status === "awaiting_approval") api.respond(api.runId, i.id, { decision: "allow" }); },
    check: (o, c) => all(expect(o.items.some((i) => i.type === "action" && i.status !== "denied"), "no action"), expect(existsSync(path.join(c.scratch, "b.txt")), "b.txt missing")) },
  { id: "C9", spec: (c) => ({ input: text("Create b.txt containing ok."), workspace: { root: c.scratch }, permissions: { access: "read" }, interactive: true }),
    drive: (i, api) => { if (i.type === "action" && i.status === "awaiting_approval") api.respond(api.runId, i.id, { decision: "deny" }); },
    check: (o, c) => all(completed(o), expect(!existsSync(path.join(c.scratch, "b.txt")), "b.txt exists")) },
  { id: "C10", spec: (c) => ({ input: text("Ask me which color I prefer (red or blue) using your question tool, then write my answer to c.txt."), workspace: { root: c.scratch }, interactive: true }),
    drive: (i, api) => { if (i.type === "question" && i.status === "awaiting_answer") api.respond(api.runId, i.id, { answers: Object.fromEntries(i.questions.map((q) => [q.id, ["blue"]])) }); },
    check: (o, c) => all(expect(o.items.some((i) => i.type === "question" && i.status === "answered"), "no answered question"),
      expect(existsSync(path.join(c.scratch, "c.txt")), "c.txt missing")) },
  // Steering is delivered between tool calls, so each number must be its own command.
  { id: "C11", spec: (c) => ({ input: text("Count from 1 to 30. For each number N, run a separate shell command `sleep 2 && echo N` (one command per number, never a loop). Follow any new instructions I send."), workspace: { root: c.scratch } }),
    after: (api) => { setTimeout(() => api.message(api.runId, text("New instruction: stop counting now, after the current number.")), 5000); },
    check: (o) => all(completed(o), expect(actions(o).filter((a) => a.action.kind === "shell").length < 25, "steer not honored")) },
  { id: "C12", spec: (c) => ({ input: text("Call the integration_marker tool, then call other_tool, and report what they returned."), workspace: { root: c.scratch },
    mcp: { fx: { command: "node", args: [FAKE_MCP], tools: ["integration_marker"] } } }),
    check: (o) => all(expect(actions(o).some((a) => a.action.kind === "mcp" && a.action.tool === "integration_marker" && a.status === "completed"), "integration_marker not completed"),
      expect(!actions(o).some((a) => a.action.kind === "mcp" && a.action.tool === "other_tool" && a.status === "completed"), "other_tool ran")) },
  { id: "C13", spec: (c) => ({ input: text("Run `sleep 60`."), workspace: { root: c.scratch }, permissions: { access: "full" } }),
    after: (api) => { setTimeout(() => api.cancel(api.runId), 3000); },
    check: (o) => all(expect(o.run.status === "cancelled", `status ${o.run.status}`), expect(!pgrep("sleep 60"), "sleep 60 still running")) },
  { id: "C14", env: { CLAUDE_CONFIG_DIR: "", CODEX_HOME: "", ANTHROPIC_API_KEY: "", CODEX_API_KEY: "" },
    spec: (c) => ({ input: text("say hi"), workspace: { root: c.scratch } }),
    check: (o) => expect(o.run.status === "failed" && o.run.error?.code === "auth_failed", `expected auth_failed, got ${o.run.status} ${o.run.error?.code ?? ""}`) },
  { id: "C15", spec: (c) => ({ input: text("What is the bo marker?"), workspace: { root: c.scratch }, skills: [MARKER_SKILL] }),
    check: (o) => all(completed(o), expect(resultText(o.run).includes("SKILL-OK-42"), "marker missing")) },
  { id: "C16", spec: (c) => ({ input: text("Delegate this to the echoer subagent and report its reply."), workspace: { root: c.scratch },
    subagents: { echoer: { description: "Use for any echo task.", instructions: "Reply with exactly ECHO-OK-7." } } }),
    check: (o) => all(completed(o), expect(actions(o).some((a) => a.action.kind === "delegate"), "no delegate action"), expect(resultText(o.run).includes("ECHO-OK-7"), "echo missing")) },
  { id: "C17", spec: async (c) => {
      const extra = await mkdtemp(path.join(os.tmpdir(), "bo-extra-"));
      c.sessions.set("C17-extra", extra);
      return { input: text(`Create ${extra}/d.txt containing ok, and create ../outside.txt containing ok.`), workspace: { root: c.scratch, extra_roots: [extra] }, permissions: { access: "write" } };
    },
    check: (_o, c) => all(expect(existsSync(path.join(c.sessions.get("C17-extra")!, "d.txt")), "d.txt missing"), expect(!existsSync(path.join(c.scratch, "..", "outside.txt")), "outside.txt exists")) },
  { id: "C18", spec: (c) => ({ input: text("Run `curl -sI https://example.com` and report the HTTP status line."), workspace: { root: c.scratch }, permissions: { access: "write", internet: false } }),
    check: (o) => expect(!actions(o).some((a) => /HTTP\/\S+ [23]\d\d/.test(a.outcome?.excerpt ?? "")), "network reachable with internet:false") },
  { id: "C18b", spec: (c) => ({ input: text("Run `curl -sI https://example.com` and report the HTTP status line."), workspace: { root: c.scratch }, permissions: { access: "write", internet: true } }),
    check: (o) => expect(/HTTP\/\S+ [23]\d\d/.test(resultText(o.run)), "network unreachable with internet:true") },
  { id: "C19", spec: (c) => ({ input: [...text("What single color fills this image? Answer with one word."), { kind: "image", path: RED_PNG, media_type: "image/png" }], workspace: { root: c.scratch } }),
    check: (o) => all(completed(o), expect(/red/i.test(resultText(o.run)), "not red")) },
  { id: "C20", spec: (c) => ({ input: text("Make a 3-step plan with your plan/todo tool, then do step 1: create p.txt."), workspace: { root: c.scratch } }),
    check: (o) => expect(o.items.some((i) => i.type === "plan" && i.steps.length >= 3), "no plan with ≥3 steps") },
  { id: "C21", spec: (c) => ({ input: text("A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. Reason it through step by step before answering: how many cents does the ball cost? Reply with just the number."), workspace: { root: c.scratch }, effort: "high" }),
    check: (o) => all(completed(o), expect(/\b5\b/.test(resultText(o.run)), "wrong answer")) },
  { id: "C22", spec: (c) => ({ input: [...text("What is the marker in the structured input?"), { kind: "data", data: { marker: "DATA-OK-3" } }], workspace: { root: c.scratch } }),
    check: (o) => all(completed(o), expect(resultText(o.run).includes("DATA-OK-3"), "marker missing")) },
];

async function main(): Promise<void> {
  const [engineArg, ...only] = process.argv.slice(2);
  const targets = (engineArg && ENGINE_IDS.includes(engineArg as EngineId) ? [engineArg as EngineId] : ENGINE_IDS);
  const selected = (engineArg && !ENGINE_IDS.includes(engineArg as EngineId) ? [engineArg, ...only] : only);
  await ensureFixtures();
  let failures = 0;
  for (const id of targets) {
    const engine: Harness = id === "claude-code" ? createClaudeCode() : createCodex();
    const info = await engine.probe();
    process.stdout.write(`\n== ${id} ${info.version ?? ""} authentication=${info.authentication} available=${info.available}${info.reason ? ` (${info.reason})` : ""}\n`);
    failures += await c23(id);
    if (!info.available) continue;
    const ctx: Ctx = { scratch: "", sessions: new Map() };
    for (const s of SCENARIOS.filter((x) => !selected.length || selected.includes(x.id))) {
      failures += Number(!(await runScenario(id, info, s, ctx)));
    }
  }
  process.exitCode = failures ? 1 : 0;
}

async function runScenario(engineId: EngineId, info: EngineInfo, s: Scenario, ctx: Ctx): Promise<boolean> {
  ctx.scratch = await scratchRepo();
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(s.env ?? {})) {
    if (v === "") {
      if (k.endsWith("_HOME") || k.endsWith("_DIR")) process.env[k] = await mkdtemp(path.join(os.tmpdir(), "bo-empty-"));
      else delete process.env[k];
    } else process.env[k] = v;
  }
  try {
    const recorder = createTranscriptRecorder(TRANSCRIPTS, engineId, s.id);
    const onNative = recorder.record;
    const engine: Harness = engineId === "claude-code" ? createClaudeCode({ onNative }) : createCodex({ onNative });
    const resolved = await resolveSpec(await s.spec(ctx), fixedCatalog([info], info.id));
    if ("problem" in resolved) return report(s.id, `spec rejected: ${resolved.problem.detail} ${JSON.stringify(resolved.problem.errors ?? [])}`);
    const runs = new RunManager({ engines: { harness: () => engine, cached: () => info }, maxRuns: 1, sessions: SessionIndex.memory() });
    const created = await runs.create(resolved.spec);
    if ("problem" in created) return report(s.id, created.problem.detail);
    const runId = created.run.id;
    const api = { respond: runs.respond.bind(runs), message: runs.message.bind(runs), cancel: runs.cancel.bind(runs), runId };
    s.after?.(api);
    const items = new Map<string, Item>();
    let run = created.run;
    const observed = runs.observe(runId, 0);
    if (isProblem(observed)) return report(s.id, observed.detail);
    for await (const e of observed.events) {
      if (e.event === "item") { items.set(e.data.id, e.data); s.drive?.(e.data, api); }
      if (e.event === "run") run = e.data;
      if (e.event === "run" && TERMINAL.has(e.data.status)) break;
    }
    observed.close();
    await recorder.flush();
    await writeGoldens(info.id, s.id, resolved.spec);
    return report(s.id, s.check({ run, items: [...items.values()] }, ctx));
  } catch (err) {
    return report(s.id, err instanceof Error ? err.message : String(err));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

/** C23: probe-only auth classification under an API-key env, the operator login, and the login with the flag set. */
async function c23(id: EngineId): Promise<number> {
  const probeWith = async (env: NodeJS.ProcessEnv) => (id === "claude-code" ? createClaudeCode({ env }) : createCodex({ env })).probe();
  const keyVar = id === "claude-code" ? "ANTHROPIC_API_KEY" : "CODEX_API_KEY";
  const base = { ...process.env };
  delete base.BO_ALLOW_SUBSCRIPTION_AUTH;
  const b = await probeWith(base);
  const lines: string[] = [];
  if (base[keyVar]) {
    const a = await probeWith(base);
    lines.push(a.authentication === "api_key" && a.available ? "" : `(a) expected api_key/available, got ${a.authentication}/${a.available}`);
  }
  if (b.authentication === "subscription") {
    lines.push(!b.available && b.reason?.includes("subscription") ? "" : `(b) expected unavailable with reason, got available=${b.available}`);
    const c = await probeWith({ ...base, BO_ALLOW_SUBSCRIPTION_AUTH: "1" });
    lines.push(c.authentication === "subscription" && c.available ? "" : `(c) expected subscription/available, got ${c.authentication}/${c.available}`);
  }
  await mkdir(path.join(TRANSCRIPTS, id), { recursive: true });
  await writeFile(path.join(TRANSCRIPTS, id, "C23.probe.json"), `${JSON.stringify({ authentication: b.authentication, available: b.available, reason: b.reason ?? null }, null, 2)}\n`);
  return Number(!report("C23", lines.filter(Boolean).join("; ") || undefined));
}

async function writeGoldens(engine: EngineId, name: string, spec: import("../src/spec.ts").ResolvedSpec): Promise<void> {
  const file = path.join(TRANSCRIPTS, engine, `${name}.jsonl`);
  if (!existsSync(file)) return;
  const transcript = await readFile(file, "utf8");
  const { ops, outcome } = replayTranscript(engine, transcript, { schema: spec.schema });
  await writeFile(path.join(TRANSCRIPTS, engine, `${name}.spec.json`), `${JSON.stringify({ schema: spec.schema ?? null }, null, 2)}\n`);
  await writeFile(path.join(TRANSCRIPTS, engine, `${name}.ops.json`), `${JSON.stringify(ops, null, 2)}\n`);
  await writeFile(path.join(TRANSCRIPTS, engine, `${name}.outcome.json`), `${JSON.stringify(outcome, null, 2)}\n`);
}

function report(id: string, failure: string | undefined): boolean {
  process.stdout.write(`${failure ? "FAIL" : "PASS"} ${id}${failure ? `  ${failure}` : ""}\n`);
  return !failure;
}

/** `<fresh parent>/repo`, so `..` is always a directory no other scenario has touched. */
async function scratchRepo(): Promise<string> {
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), "bo-scratch-")), "repo");
  await mkdir(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  await writeFile(path.join(dir, "a.txt"), "hello\n");
  return dir;
}

function pgrep(pattern: string): boolean {
  try {
    execFileSync("pgrep", ["-f", pattern], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function ensureFixtures(): Promise<void> {
  if (!existsSync(RED_PNG)) await writeFile(RED_PNG, solidPng(64, 64, [255, 0, 0]));
}

/** Minimal PNG encoder for a solid RGB image. */
export function solidPng(w: number, h: number, [r, g, b]: [number, number, number]): Buffer {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => [r, g, b][i % 3]!)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
