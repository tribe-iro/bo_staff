import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeEventParser } from "../../src/adapters/claude/parser.ts";

// A representative `claude -p --output-format stream-json --verbose` transcript: system init,
// an assistant turn (thinking + text + tool_use), a tool result, a second assistant turn, and
// the terminal `result` object carrying the final text, session id, and usage (incl. cache).
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const TRANSCRIPT_LINES = [
  JSON.stringify({ type: "system", subtype: "init", session_id: SESSION_ID, model: "claude-sonnet-4-6", tools: ["Bash", "Read"] }),
  JSON.stringify({
    type: "assistant",
    session_id: SESSION_ID,
    message: {
      id: "msg_1", role: "assistant", content: [
        { type: "thinking", thinking: "Let me run the tests first." },
        { type: "text", text: "I'll check the failing tests." },
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } },
      ],
    },
  }),
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "2 failing" }] } }),
  JSON.stringify({
    type: "assistant",
    session_id: SESSION_ID,
    message: { id: "msg_2", role: "assistant", content: [{ type: "text", text: "Fixed." }] },
  }),
  JSON.stringify({
    type: "result", subtype: "success", is_error: false, duration_ms: 47000, num_turns: 2,
    result: "Fixed two failing validation tests.", session_id: SESSION_ID, total_cost_usd: 0.05,
    usage: { input_tokens: 12000, output_tokens: 850, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200 },
  }),
];
const TRANSCRIPT = TRANSCRIPT_LINES.join("\n") + "\n";

test("claude stream-json parser projects live events (turns, thinking, tool use)", () => {
  const parser = new ClaudeEventParser();
  const events = parser.onStdoutChunk(TRANSCRIPT);

  const turnBoundaries = events.filter((e) => e.type === "provider.turn_boundary");
  assert.equal(turnBoundaries.length, 2, "two assistant turns → two turn boundaries");

  const thinking = events.find((e) => e.type === "provider.progress" && e.progress?.current_phase === "thinking");
  assert.ok(thinking, "thinking block surfaced as a thinking-phase progress event");
  assert.match(thinking!.type === "provider.progress" ? thinking!.message ?? "" : "", /run the tests/);

  const tool = events.find((e) => e.type === "provider.progress" && e.progress?.last_tool_command === "npm test");
  assert.ok(tool, "tool_use surfaced with its command");
});

test("claude stream-json parser finish() extracts result, session id, and cache usage", () => {
  const parser = new ClaudeEventParser();
  parser.onStdoutChunk(TRANSCRIPT);
  const summary = parser.finish({ stdout: TRANSCRIPT, stderr: "" });

  assert.equal(summary.raw_output_text, "Fixed two failing validation tests.");
  assert.equal(summary.continuation_token, SESSION_ID);
  assert.equal(summary.usage?.input_tokens, 12000);
  assert.equal(summary.usage?.output_tokens, 850);
  assert.equal(summary.usage?.cache_read_tokens, 5000);
  assert.equal(summary.usage?.cache_creation_tokens, 200);
  assert.equal(summary.usage?.duration_ms, 47000);
  assert.equal(summary.usage?.turns, 2);
});

test("claude stream-json parser reassembles events split across chunk boundaries", () => {
  const parser = new ClaudeEventParser();
  // Split mid-line to exercise the NDJSON line buffer.
  const mid = Math.floor(TRANSCRIPT.length / 2);
  const events = [
    ...parser.onStdoutChunk(TRANSCRIPT.slice(0, mid)),
    ...parser.onStdoutChunk(TRANSCRIPT.slice(mid)),
  ];
  assert.equal(events.filter((e) => e.type === "provider.turn_boundary").length, 2);
  const summary = parser.finish({ stdout: TRANSCRIPT, stderr: "" });
  assert.equal(summary.continuation_token, SESSION_ID);
});

test("claude stream-json parser is defensive: malformed and unknown lines never throw", () => {
  const parser = new ClaudeEventParser();
  const events = parser.onStdoutChunk('{ not json\n{"type":"mystery_event","x":1}\n');
  // Malformed line skipped; unknown type passed through as generic progress.
  assert.ok(events.every((e) => e.type === "provider.progress"));
  assert.ok(events.some((e) => e.type === "provider.progress" && /mystery_event/.test(e.message ?? "")));
});

test("claude stream-json parser prefers structured_output for custom output format", () => {
  const parser = new ClaudeEventParser();
  const line = JSON.stringify({
    type: "result", subtype: "success", session_id: SESSION_ID,
    result: "ignored prose", structured_output: { content: "the structured answer" },
    usage: { input_tokens: 10, output_tokens: 5 },
  }) + "\n";
  parser.onStdoutChunk(line);
  const summary = parser.finish({ stdout: line, stderr: "" });
  assert.equal(summary.raw_output_text, "the structured answer");
});
