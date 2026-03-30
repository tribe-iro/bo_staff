import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { EnvelopeBuilder, RUNTIME_SENDER, agentSender } from "../../src/bomcp/envelope-builder.ts";
import { LeaseValidator, buildLease } from "../../src/bomcp/lease.ts";
import { ControllerStream } from "../../src/bomcp/controller-stream.ts";
import { BomcpToolHandler } from "../../src/bomcp/tool-handler.ts";
import { BOMCP_TOOL_NAMES } from "../../src/bomcp/types.ts";
import type { BomcpEnvelope, EphemeralExecutionState } from "../../src/bomcp/types.ts";

test("EnvelopeBuilder assigns monotonic sequences", () => {
  const builder = new EnvelopeBuilder("exec_1");
  const e1 = builder.build({ kind: "execution.started", sender: RUNTIME_SENDER, payload: {} });
  const e2 = builder.build({ kind: "progress.update", sender: agentSender("a1"), payload: {} });
  const e3 = builder.build({ kind: "execution.completed", sender: RUNTIME_SENDER, payload: {} });
  assert.equal(e1.sequence, 1);
  assert.equal(e2.sequence, 2);
  assert.equal(e3.sequence, 3);
  assert.equal(e1.execution_id, "exec_1");
});

test("EnvelopeBuilder includes optional fields when provided", () => {
  const builder = new EnvelopeBuilder("exec_1");
  const e = builder.build({
    kind: "control.handoff",
    sender: agentSender("agent_1"),
    payload: { kind: "completed" },
    request_id: "req_1",
    reply_to: "msg_1",
    correlation_id: "cor_1",
  });
  assert.equal(e.request_id, "req_1");
  assert.equal(e.reply_to, "msg_1");
  assert.equal(e.correlation_id, "cor_1");
});

test("buildLease defaults to all tools when none specified", () => {
  const lease = buildLease({ executionId: "exec_1" });
  assert.equal(lease.allowed_tools.length, BOMCP_TOOL_NAMES.length);
  assert.equal(lease.expires_at, undefined);
});

test("LeaseValidator allows listed tools", () => {
  const lease = buildLease({ executionId: "exec_1", allowedTools: ["bomcp.control.handoff"] });
  const v = new LeaseValidator(lease);
  assert.deepEqual(v.validateToolCall("bomcp.control.handoff"), { allowed: true });
});

test("LeaseValidator rejects unlisted tools", () => {
  const lease = buildLease({ executionId: "exec_1", allowedTools: ["bomcp.progress.update"] });
  const v = new LeaseValidator(lease);
  const result = v.validateToolCall("bomcp.control.handoff");
  assert.equal(result.allowed, false);
});

test("LeaseValidator rejects expired lease", () => {
  const lease = buildLease({ executionId: "exec_1", allowedTools: ["bomcp.progress.update"], timeoutSeconds: -1 });
  lease.expires_at = new Date(Date.now() - 1000).toISOString();
  const v = new LeaseValidator(lease);
  const result = v.validateToolCall("bomcp.progress.update");
  assert.equal(result.allowed, false);
  assert.ok("reason" in result && result.reason === "lease_expired");
});

test("ControllerStream emits envelopes via writer", async () => {
  const emitted: BomcpEnvelope[] = [];
  const builder = new EnvelopeBuilder("exec_1");
  const stream = new ControllerStream(async (e) => { emitted.push(e); }, builder);

  const started = await stream.emitRuntime("execution.started", { backend: "claude" });
  const progress = await stream.emitAgent("agent_1", "progress.update", { phase: "analyzing" });

  assert.equal(emitted.length, 2);
  assert.equal(started.delivered, true);
  assert.equal(progress.delivered, true);
  assert.equal(emitted[0].kind, "execution.started");
  assert.equal(emitted[1].kind, "progress.update");
});

test("ControllerStream skips writes after close", async () => {
  const emitted: BomcpEnvelope[] = [];
  const builder = new EnvelopeBuilder("exec_1");
  const stream = new ControllerStream(async (e) => { emitted.push(e); }, builder);

  const started = await stream.emitRuntime("execution.started", {});
  stream.close();
  const completed = await stream.emitRuntime("execution.completed", {});

  assert.equal(emitted.length, 1);
  assert.equal(started.delivered, true);
  assert.equal(completed.delivered, false);
  assert.equal(completed.envelope.kind, "execution.completed");
  assert.ok(stream.isClosed);
});

function makeState(overrides?: Partial<EphemeralExecutionState>): EphemeralExecutionState {
  return {
    execution_id: "exec_1",
    backend: "claude",
    status: "running",
    lease: buildLease({ executionId: "exec_1" }),
    artifacts: new Map(),
    processed_request_ids: new Map(),
    started_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeToolHandler(opts?: {
  allowedTools?: string[];
  artifactRoot?: string;
  signal?: AbortSignal;
}) {
  const emitted: BomcpEnvelope[] = [];
  const state = makeState({
    lease: buildLease({ executionId: "exec_1", allowedTools: opts?.allowedTools }),
  });
  const builder = new EnvelopeBuilder("exec_1");
  const stream = new ControllerStream(async (e) => { emitted.push(e); }, builder);
  const signal = opts?.signal ?? new AbortController().signal;
  const handler = new BomcpToolHandler(stream, state, signal, opts?.artifactRoot);
  return { handler, emitted, state, stream };
}

test("control.handoff emits a typed agent handoff and returns acknowledged", async () => {
  const { handler, emitted } = makeToolHandler();
  const resp = await handler.handle({
    type: "tool_call",
    tool_name: "bomcp.control.handoff",
    params: {
      kind: "continue_with_prompt",
      reason_code: "tests_failed",
      next: { prompt_id: "debug_failures" },
      payload: { failing_suite: "unit" },
    },
    request_id: "req_1",
  });

  assert.deepEqual(resp.result, { acknowledged: true, kind: "continue_with_prompt" });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].kind, "control.handoff");
  assert.equal(emitted[0].sender.type, "agent");
  assert.equal((emitted[0].payload as Record<string, unknown>).reason_code, "tests_failed");
});

test("control.handoff validates required next target fields", async () => {
  const { handler } = makeToolHandler();
  const resp = await handler.handle({
    type: "tool_call",
    tool_name: "bomcp.control.handoff",
    params: { kind: "continue_with_node" },
    request_id: "req_bad",
  });

  assert.ok(resp.error);
  assert.equal(resp.error!.code, "invalid_tool_params");
  assert.match(resp.error!.message, /next\.node_id/);
});

test("control.handoff validates input request fields for needs_input", async () => {
  const { handler } = makeToolHandler();
  const resp = await handler.handle({
    type: "tool_call",
    tool_name: "bomcp.control.handoff",
    params: { kind: "needs_input", input_request: { kind: "text", prompt: "" } },
    request_id: "req_needs_input",
  });

  assert.ok(resp.error);
  assert.equal(resp.error!.code, "invalid_tool_params");
  assert.match(resp.error!.message, /input_request\.prompt/);
});

test("progress.update rejects malformed params at the boundary", async () => {
  const { handler } = makeToolHandler();
  const resp = await handler.handle({
    type: "tool_call",
    tool_name: "bomcp.progress.update",
    params: { percent: "fifty" },
    request_id: "req_progress_bad",
  });

  assert.ok(resp.error);
  assert.equal(resp.error!.code, "invalid_tool_params");
  assert.match(resp.error!.message, /percent/);
});

test("artifact.register rejects malformed params at the boundary", async () => {
  const { handler } = makeToolHandler();
  const resp = await handler.handle({
    type: "tool_call",
    tool_name: "bomcp.artifact.register",
    params: { kind: "report", path: 7 },
    request_id: "req_artifact_bad",
  });

  assert.ok(resp.error);
  assert.equal(resp.error!.code, "invalid_tool_params");
  assert.match(resp.error!.message, /path/);
});

test("tool call rejected when not in allowed_tools", async () => {
  const { handler, emitted } = makeToolHandler({ allowedTools: ["bomcp.progress.update"] });
  const resp = await handler.handle({
    type: "tool_call",
    tool_name: "bomcp.control.handoff",
    params: { kind: "blocked", reason_code: "missing_config" },
    request_id: "req_1",
  });
  assert.ok(resp.error);
  assert.equal(resp.error!.code, "lease_tool_denied");
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].kind, "system.error");
});

test("tool call rejected when execution not active", async () => {
  const { handler, state } = makeToolHandler();
  state.status = "completed";
  const resp = await handler.handle({
    type: "tool_call",
    tool_name: "bomcp.progress.update",
    params: { phase: "done" },
    request_id: "req_1",
  });
  assert.ok(resp.error);
  assert.equal(resp.error!.code, "execution_not_active");
});

test("tool call rejected when execution has been aborted", async () => {
  const abortController = new AbortController();
  abortController.abort("cancel_request");
  const { handler } = makeToolHandler({ signal: abortController.signal });
  const resp = await handler.handle({
    type: "tool_call",
    tool_name: "bomcp.progress.update",
    params: { phase: "done" },
    request_id: "req_aborted",
  });

  assert.ok(resp.error);
  assert.equal(resp.error!.code, "execution_cancelled");
});

test("duplicate request_id returns cached response", async () => {
  const { handler, emitted } = makeToolHandler();
  const resp1 = await handler.handle({
    type: "tool_call",
    tool_name: "bomcp.control.handoff",
    params: { kind: "completed", reason_code: "done" },
    request_id: "req_dup",
  });
  const countAfterFirst = emitted.length;
  const resp2 = await handler.handle({
    type: "tool_call",
    tool_name: "bomcp.control.handoff",
    params: { kind: "completed", reason_code: "done" },
    request_id: "req_dup",
  });
  assert.deepEqual(resp1.result, resp2.result);
  assert.equal(emitted.length, countAfterFirst);
});

test("concurrent tool calls settle independently with monotonic envelope ordering", async () => {
  const { handler, emitted, state } = makeToolHandler();
  const [progressA, handoff, progressB] = await Promise.all([
    handler.handle({
      type: "tool_call",
      tool_name: "bomcp.progress.update",
      params: { phase: "scan", percent: 10 },
      request_id: "req_progress_a",
    }),
    handler.handle({
      type: "tool_call",
      tool_name: "bomcp.control.handoff",
      params: { kind: "continue_with_prompt", next: { prompt_id: "review" } },
      request_id: "req_handoff",
    }),
    handler.handle({
      type: "tool_call",
      tool_name: "bomcp.progress.update",
      params: { phase: "scan", percent: 90 },
      request_id: "req_progress_b",
    }),
  ]);

  assert.deepEqual(progressA.result, { acknowledged: true });
  assert.deepEqual(handoff.result, { acknowledged: true, kind: "continue_with_prompt" });
  assert.deepEqual(progressB.result, { acknowledged: true });
  assert.equal(emitted.length, 3);
  assert.deepEqual(emitted.map((event) => event.sequence), [1, 2, 3]);
  assert.equal(state.processed_request_ids.size, 3);
});

test("progress.update emits agent progress and returns acknowledged", async () => {
  const { handler, emitted } = makeToolHandler();
  const resp = await handler.handle({
    type: "tool_call",
    tool_name: "bomcp.progress.update",
    params: { phase: "analyzing", percent: 50, detail: "reading files" },
    request_id: "req_progress",
  });

  assert.deepEqual(resp.result, { acknowledged: true });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].kind, "progress.update");
  assert.equal(emitted[0].sender.type, "agent");
});

test("progress.update fails when controller stream is already closed", async () => {
  const { handler, stream } = makeToolHandler();
  stream.close();
  const resp = await handler.handle({
    type: "tool_call",
    tool_name: "bomcp.progress.update",
    params: { phase: "analyzing" },
    request_id: "req_progress_closed",
  });

  assert.ok(resp.error);
  assert.equal(resp.error!.code, "internal");
  assert.match(resp.error!.message, /not delivered/);
});

test("artifact.register registers and emits artifact.registered", async () => {
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "bo-staff-art-root-"));
  try {
    await writeFile(path.join(artifactRoot, "review.md"), "handoff");
    const { handler, emitted, state } = makeToolHandler({ artifactRoot });
    const resp = await handler.handle({
      type: "tool_call",
      tool_name: "bomcp.artifact.register",
      params: { kind: "review", path: "review.md", metadata: { role: "handoff" } },
      request_id: "req_art",
    });
    const result = resp.result as { artifact_id: string; status: string };
    assert.equal(result.status, "registered");
    assert.ok(result.artifact_id);
    assert.equal(state.artifacts.size, 1);

    const registered = emitted.find((e) => e.kind === "artifact.registered");
    assert.ok(registered);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("artifact.register does not mutate state after abort", async () => {
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "bo-staff-art-root-"));
  const abortController = new AbortController();
  try {
    await writeFile(path.join(artifactRoot, "review.md"), "handoff");
    abortController.abort("cancel_request");
    const { handler, state } = makeToolHandler({ artifactRoot, signal: abortController.signal });
    const resp = await handler.handle({
      type: "tool_call",
      tool_name: "bomcp.artifact.register",
      params: { kind: "review", path: "review.md" },
      request_id: "req_art_abort",
    });

    assert.ok(resp.error);
    assert.equal(resp.error!.code, "execution_cancelled");
    assert.equal(state.artifacts.size, 0);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("artifact.require returns missing for non-existent file", async () => {
  const { handler, emitted } = makeToolHandler({ artifactRoot: "/tmp/nonexistent-worktree-abc123" });
  const resp = await handler.handle({
    type: "tool_call",
    tool_name: "bomcp.artifact.require",
    params: { kind: "test_results", path: "test-output/results.json" },
    request_id: "req_require",
  });
  const result = resp.result as { status: string };
  assert.equal(result.status, "missing");

  const missing = emitted.find((e) => e.kind === "artifact.missing");
  assert.ok(missing);
});

test("artifact.register rejects paths outside the artifact root", async () => {
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "bo-staff-art-root-"));
  const outsideFile = path.join(os.tmpdir(), `bo-staff-art-outside-${Date.now()}.txt`);
  try {
    await writeFile(outsideFile, "secret");
    const { handler, emitted } = makeToolHandler({ artifactRoot });
    const resp = await handler.handle({
      type: "tool_call",
      tool_name: "bomcp.artifact.register",
      params: { kind: "review", path: path.relative(artifactRoot, outsideFile) },
      request_id: "req_art_escape",
    });

    assert.deepEqual(resp.result, { status: "rejected", reason: "path_outside_artifact_root" });
    const rejected = emitted.find((e) => e.kind === "artifact.registration_rejected");
    assert.ok(rejected);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
    await rm(outsideFile, { force: true });
  }
});

test("artifact.require rejects paths outside the artifact root", async () => {
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "bo-staff-art-root-"));
  const outsideFile = path.join(os.tmpdir(), `bo-staff-art-outside-${Date.now()}.txt`);
  try {
    await writeFile(outsideFile, "secret");
    const { handler } = makeToolHandler({ artifactRoot });
    const resp = await handler.handle({
      type: "tool_call",
      tool_name: "bomcp.artifact.require",
      params: { kind: "review", path: path.relative(artifactRoot, outsideFile) },
      request_id: "req_art_require_escape",
    });

    assert.deepEqual(resp.result, { status: "rejected", reason: "path_outside_artifact_root" });
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
    await rm(outsideFile, { force: true });
  }
});
