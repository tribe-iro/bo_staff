import { test } from "node:test";
import assert from "node:assert/strict";
import { describe, streamLogger } from "../src/log.ts";
import type { EngineInfo, Item, Run, StreamEvent } from "../src/model.ts";
import { problem } from "../src/problems.ts";
import { count, duration } from "../src/format.ts";
import { enginesTable, problemText, RunView, runsTable, styleFor } from "../src/render.ts";

const plain = styleFor({ isTTY: false });

function sink(isTTY = false) {
  let text = "";
  return { stream: { isTTY, write: (s: string) => { text += s; } }, text: () => text };
}

let seq = 0;
const item = (data: Partial<Item> & Pick<Item, "type">): StreamEvent => ({ event: "item", id: ++seq, data: { id: `itm_${seq}`, created_at: "", ...data } as Item });

const run = (over: Partial<Run> = {}): Run => ({
  id: "run_1", session_id: "ses_abc", status: "completed", engine: { id: "codex", version: "1" }, model: "gpt-x",
  created_at: "2026-09-23T10:00:00.000Z", ended_at: "2026-09-23T10:00:42.000Z",
  usage: { input_tokens: 11_131, output_tokens: 214, cached_input_tokens: 8_704, cost_usd: 0.0646 },
  result: { kind: "text", text: "All tests pass." }, ...over,
});

test("numbers and durations read like a person wrote them", () => {
  assert.deepEqual([950, 11_131, 250_000, 2_400_000].map(count), ["950", "11.1k", "250k", "2.4M"]);
  assert.deepEqual([8_000, 125_000, 3_720_000].map(duration), ["8s", "2m 05s", "1h 02m"]);
});

test("a run reads as: words, one line per step, the answer on stdout, one summary line", () => {
  const out = sink();
  const err = sink();
  const view = new RunView(out.stream, err.stream, { style: plain, verbosity: 1 });
  const events: StreamEvent[] = [
    item({ type: "message", role: "user", content: [{ kind: "text", text: "fix it" }], status: "completed" }),
    item({ type: "message", role: "agent", content: [{ kind: "text", text: "Looking at the tests." }], status: "completed" }),
    { ...item({ type: "action", action: { kind: "shell", command: "npm test" }, status: "running" }) },
    item({ type: "action", action: { kind: "edit", changes: [{ path: "src/a.ts", change: "modify" }] }, status: "denied", reason: "not permitted by access level read" }),
    item({ type: "action", action: { kind: "shell", command: "make" }, status: "failed", outcome: { exit_code: 2 } }),
    item({ type: "plan", steps: [{ text: "reproduce", status: "completed" }, { text: "fix", status: "in_progress" }] }),
    item({ type: "plan", steps: [{ text: "reproduce", status: "completed" }, { text: "fix", status: "in_progress" }] }),
    item({ type: "notice", level: "warning", text: "API retry 1/10 in 2s" }),
  ];
  for (const e of events) view.event(e);
  view.finish(run());
  assert.equal(out.text(), "All tests pass.\n");
  assert.equal(err.text(), [
    "Looking at the tests.",
    "  ▸ $ npm test",
    "  ⊘ edit src/a.ts · not permitted by access level read",
    "  ✗ $ make · exit 2",
    "  plan 1/2 · fix",
    "  ! API retry 1/10 in 2s",
    "",
    "✓ done · gpt-x · 42s · 11.1k in (8.7k cached) · 214 out · $0.0646",
    '  continue: bo run -c "…"',
    "",
  ].join("\n"));
});

test("failures say what happened and what to do next", () => {
  const err = sink();
  new RunView(sink().stream, err.stream, { style: plain }).finish(run({
    status: "failed", result: undefined, error: { code: "rate_limited", message: "Codex rate limit exceeded" },
  }));
  assert.match(err.text(), /^✗ Codex rate limit exceeded · rate_limited · 42s\n  wait and retry, or try the other engine with --engine\n/);
});

test("problems list their fields by name, with a hint", () => {
  const text = problemText(problem("invalid_spec", "the run spec is invalid", [{ pointer: "/subagents/a~1b/effort", detail: "must be one of low, high" }]), plain);
  assert.equal(text, "bo: the run spec is invalid\n  subagents.a/b.effort  must be one of low, high\n");
  assert.match(problemText(problem("engine_unavailable", "codex is unavailable"), plain), /\n  `bo engines` shows each engine's state\n$/);
});

test("engines and runs are aligned tables; no colour codes off a terminal", () => {
  const engines: EngineInfo[] = [
    { id: "claude-code", available: true, version: "2.1.280", authentication: "api_key", models: [
      { id: "claude-a", aliases: ["default", "opus"], default: true, efforts: ["low", "high"], images: true },
      { id: "claude-h", aliases: [], default: false, efforts: [], images: false },
    ] },
    { id: "codex", available: false, authentication: "subscription", reason: "logged in with a personal subscription", models: [] },
  ];
  assert.equal(enginesTable(engines, plain), [
    "● claude-code 2.1.280 · api_key",
    "  model               aliases        effort",
    "  claude-a (default)  default, opus  low high",
    "  claude-h            –              –         no images",
    "",
    "○ codex unavailable",
    "  logged in with a personal subscription",
    "",
  ].join("\n"));
  const table = runsTable([run(), run({ id: "run_2", status: "running", model: null, ended_at: undefined })], plain, Date.parse("2026-09-23T10:05:00Z"));
  assert.equal(table, "run    status     engine  model  started\nrun_1  completed  codex   gpt-x  5m 00s ago\nrun_2  running    codex   –      5m 00s ago\n");
  assert.doesNotMatch(table, /\x1b/);
  assert.match(runsTable([], plain), /no runs/);
});

test("server log: one line per event; diagnostics readable, bounded and redacted", () => {
  const out = sink();
  streamLogger(out.stream, () => new Date(2026, 8, 23, 9, 5, 7))("run_1  failed     engine_error: boom · 1.0s", describe({
    error: new Error("Claude Code process exited with code 1"),
    stderr: "line 1\nline 2\nAuthorization: Bearer sk-live-123",
    headers: { authorization: "Bearer x" },
    usage: { input_tokens: 3 },
  }));
  assert.equal(out.text(), [
    "09:05:07  run_1  failed     engine_error: boom · 1.0s",
    "          error: Error: Claude Code process exited with code 1",
    "          stderr (last lines):",
    "            line 1",
    "            line 2",
    "            Authorization: Bearer [redacted]",
    "          headers: [redacted]",
    "          usage.input_tokens: 3",
    "",
  ].join("\n"));
  assert.equal(describe("x".repeat(1000))[0]!.length, 402, "long lines are cut");
});

test("verbosity 0, piped: the answer on stdout; stderr only for what changed the result", () => {
  const out = sink();
  const err = sink();
  const view = new RunView(out.stream, err.stream, { style: plain });
  view.event(item({ type: "message", role: "agent", content: [{ kind: "text", text: "Checking." }], status: "completed" }));
  view.event(item({ type: "action", action: { kind: "shell", command: "rm -rf /" }, status: "denied", reason: "not permitted" }));
  view.event(item({ type: "notice", level: "warning", text: "API retry 1/10 in 2s" }));
  view.finish(run());
  assert.equal(out.text(), "All tests pass.\n");
  assert.equal(err.text(), "⊘ 1 action was denied (-v shows them)\n");
});

test("verbosity 2 adds reasoning, tool output, subagent words and ids", () => {
  const err = sink();
  const view = new RunView(sink().stream, err.stream, { style: plain, verbosity: 2 });
  view.event(item({ type: "reasoning", text: "the parser drops the last token" }));
  view.event(item({ type: "action", action: { kind: "shell", command: "npm test" }, status: "completed", outcome: { exit_code: 0, excerpt: "1 passing" } }));
  view.event(item({ type: "message", role: "agent", content: [{ kind: "text", text: "ECHO" }], status: "completed", parent_id: "itm_x" }));
  view.finish(run());
  assert.match(err.text(), /^  thinking: the parser drops the last token\n  ▸ \$ npm test\n    1 passing\n    ECHO\n\n✓ done/);
  assert.match(err.text(), /  run run_1 · session ses_abc\n$/);
});

test("the status line lives only on a terminal and is erased before anything else is written", () => {
  const piped = sink(false);
  new RunView(sink().stream, piped.stream, { style: plain }).finish(run());
  assert.equal(piped.text(), "", "nothing at all off a terminal for a clean success");
  const out = sink(true);
  const tty = sink(true);
  const view = new RunView(out.stream, tty.stream, { style: plain });
  view.event(item({ type: "action", action: { kind: "shell", command: "npm test" }, status: "running" }));
  view.event({ event: "delta", data: { item_id: "itm_m", text: "Done." } });
  view.event({ event: "item", id: 99, data: { id: "itm_m", created_at: "", type: "message", role: "agent", content: [{ kind: "text", text: "Done." }], status: "completed" } });
  view.finish(run({ result: { kind: "text", text: "Done." } }));
  assert.match(tty.text(), /⠋ working · 0s/);
  assert.ok(tty.text().endsWith("\r\x1b[2K"), "erased at the end");
  assert.equal(out.text(), "Done.\n", "the streamed answer, once");
});
