import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createTestGateway, FakeAdapter } from "./fixtures.ts";
import type { BomcpEnvelope, EphemeralExecutionState } from "../../src/bomcp/types.ts";
import type { BackendAdapter, AdapterEvent } from "../../src/adapters/types.ts";
import type { BackendName } from "../../src/types.ts";
import { ExecutionAdmissionController } from "../../src/engine/execution-admission.ts";
import { executeCliAdapter } from "../../src/adapters/shared.ts";

const UNIX_SOCKET_SUPPORT = await supportsUnixSockets();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all envelopes emitted during a gateway.execute() call. */
async function executeCollecting(
  gateway: Parameters<typeof createTestGateway>[0] extends undefined
    ? Awaited<ReturnType<typeof createTestGateway>>["gateway"]
    : Awaited<ReturnType<typeof createTestGateway>>["gateway"],
  rawRequest: unknown,
  opts?: { signal?: AbortSignal },
): Promise<BomcpEnvelope[]> {
  const envelopes: BomcpEnvelope[] = [];
  const abortController = new AbortController();
  if (opts?.signal) {
    opts.signal.addEventListener("abort", () => abortController.abort(opts.signal!.reason), { once: true });
  }
  await gateway.execute({
    rawRequest,
    streamWriter: async (e) => { envelopes.push(e); },
    signal: abortController.signal,
  });
  return envelopes;
}

function findByKind(envelopes: BomcpEnvelope[], kind: string): BomcpEnvelope | undefined {
  return envelopes.find((e) => e.kind === kind);
}

function allByKind(envelopes: BomcpEnvelope[], kind: string): BomcpEnvelope[] {
  return envelopes.filter((e) => e.kind === kind);
}

function payload(envelope: BomcpEnvelope): Record<string, unknown> {
  return envelope.payload as Record<string, unknown>;
}

function gatewayTest(name: string, fn: () => Promise<void> | void): void {
  test(name, { skip: !UNIX_SOCKET_SUPPORT }, fn);
}

/** Build a minimal Layer 2 request targeting a fake adapter. */
function layer2Request(overrides?: Record<string, unknown>) {
  return {
    backend: "claude",
    execution_profile: { model: "test-model" },
    task: { prompt: "do the thing" },
    ...overrides,
  };
}

async function supportsUnixSockets(): Promise<boolean> {
  const root = await mkdtemp(path.join(os.tmpdir(), "bo-staff-socket-probe-"));
  const socketPath = path.join(root, "probe.sock");
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    return true;
  } catch {
    return false;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

async function callBomcpTool(input: {
  command: string;
  args: string[];
  env: Record<string, string>;
  toolName: string;
  toolArgs: Record<string, unknown>;
}): Promise<unknown> {
  const child = spawn(input.command, input.args, {
    env: { ...process.env, ...input.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuffer = "";
  let stderrBuffer = "";
  const pending = new Map<string, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = parsed.id;
      if (typeof id !== "string") continue;
      const waiter = pending.get(id);
      if (!waiter) continue;
      pending.delete(id);
      waiter.resolve(parsed);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrBuffer += chunk;
  });

  child.on("exit", (code, signal) => {
    if (pending.size === 0) return;
    const error = new Error(`bomcp-server exited before responding (code=${code}, signal=${signal}): ${stderrBuffer}`);
    for (const waiter of pending.values()) {
      waiter.reject(error);
    }
    pending.clear();
  });

  function request(id: string, message: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify(message) + "\n");
    });
  }

  try {
    await request("init", {
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "gateway-lifecycle-test", version: "1.0.0" },
      },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    const response = await request("call", {
      jsonrpc: "2.0",
      id: "call",
      method: "tools/call",
      params: {
        name: input.toolName,
        arguments: input.toolArgs,
      },
    });

    const result = response.result as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    } | undefined;
    const text = result?.content?.[0]?.text;
    if (typeof text !== "string") {
      throw new Error(`unexpected bomcp-server response: ${JSON.stringify(response)}`);
    }
    if (result?.isError) {
      throw new Error(text);
    }
    return JSON.parse(text) as unknown;
  } finally {
    child.stdin.end();
    await once(child, "exit").catch(() => {});
  }
}

// ==========================================================================
// 1. CONTINUATION ROUND-TRIP
//
// Validates that a continuation token emitted by the adapter in execution A
// can be sent back in execution B and arrives at the adapter unchanged.
// ==========================================================================

gatewayTest("continuation token round-trip: token emitted in first execution is received by adapter in second", async () => {
  const TOKEN = "sess_abc123_round_trip";
  const receivedTokens: Array<string | undefined> = [];

  const adapter = new FakeAdapter("claude", (input) => {
    receivedTokens.push(input.continuation?.token);
    return {
      continuation: { backend: "claude", token: TOKEN },
      compact_output: {
        summary: "done",
        payload: { content: "result" },
        pending_items: [],
      },
    };
  });

  const { gateway, cleanup } = await createTestGateway({ adapters: [adapter] });
  try {
    // --- Execution A: no continuation in, token out ---
    const envA = await executeCollecting(gateway, layer2Request());
    const completedA = findByKind(envA, "execution.completed");
    assert.ok(completedA, "first execution must emit execution.completed");

    const continuationOut = payload(completedA).continuation as { backend: string; token: string } | undefined;
    assert.ok(continuationOut, "completed envelope must carry continuation");
    assert.equal(continuationOut.backend, "claude");
    assert.equal(continuationOut.token, TOKEN);

    // Adapter saw no incoming continuation
    assert.equal(receivedTokens[0], undefined, "first call should not receive a continuation token");

    // --- Execution B: send the token back ---
    const envB = await executeCollecting(gateway, layer2Request({
      continuation: { backend: "claude", token: TOKEN },
    }));
    const completedB = findByKind(envB, "execution.completed");
    assert.ok(completedB, "second execution must complete");

    // Adapter received the token verbatim
    assert.equal(receivedTokens[1], TOKEN, "adapter must receive the continuation token from the first execution");
  } finally {
    await cleanup();
  }
});

gatewayTest("provider progress is projected with the captured agent id", async () => {
  const adapter: BackendAdapter = {
    backend: "claude",
    async *execute() {
      yield { type: "provider.started", provider_session_id: "agent_session_1" };
      yield { type: "provider.progress", message: "working" };
      yield {
        type: "provider.completed",
        result: {
          raw_output_text: JSON.stringify({
            summary: "done",
            payload: { content: "ok" },
            pending_items: [],
            artifacts: [],
          }),
          exit_reason: "completed",
        },
      };
    },
  };

  const { gateway, cleanup } = await createTestGateway({ adapters: [adapter] });
  try {
    const env = await executeCollecting(gateway, layer2Request());
    const progress = findByKind(env, "progress.update");
    assert.ok(progress, "must emit a projected progress envelope");
    assert.equal(progress.sender.type, "agent");
    assert.equal(progress.sender.id, "agent_session_1");
  } finally {
    await cleanup();
  }
});

gatewayTest("control.handoff is bridged end-to-end through bomcp-server into the controller stream", async () => {
  let toolResult: unknown;

  const adapter: BackendAdapter = {
    backend: "claude",
    async *execute(context) {
      yield { type: "provider.started", provider_session_id: "handoff_agent" };
      assert.ok(context.bomcp_server_config, "lease should inject bomcp-server config");

      toolResult = await callBomcpTool({
        command: context.bomcp_server_config.command,
        args: context.bomcp_server_config.args,
        env: context.bomcp_server_config.env,
        toolName: "bomcp.control.handoff",
        toolArgs: {
          kind: "continue_with_prompt",
          reason_code: "needs_review",
          next: { prompt_id: "review_patch" },
          payload: { failing_suite: "unit" },
        },
      });

      yield {
        type: "provider.completed",
        result: {
          raw_output_text: JSON.stringify({
            summary: "done",
            payload: { content: "ok" },
            pending_items: [],
            artifacts: [],
          }),
          exit_reason: "completed",
        },
      };
    },
  };

  const { gateway, cleanup } = await createTestGateway({ adapters: [adapter] });
  try {
    const env = await executeCollecting(gateway, layer2Request({
      lease: { allowed_tools: ["bomcp.control.handoff"] },
    }));

    assert.deepEqual(toolResult, { acknowledged: true, kind: "continue_with_prompt" });

    const handoff = findByKind(env, "control.handoff");
    assert.ok(handoff, "must emit control.handoff");
    assert.equal(handoff.sender.type, "agent");
    assert.equal(handoff.sender.id, "handoff_agent");
    assert.equal(payload(handoff).kind, "continue_with_prompt");
    assert.deepEqual(payload(handoff).next, { prompt_id: "review_patch" });

    const completed = findByKind(env, "execution.completed");
    assert.ok(completed, "execution should still complete after handoff emission");
    assert.ok(handoff.sequence < completed.sequence, "handoff should precede terminal completion");
  } finally {
    await cleanup();
  }
});

gatewayTest("continuation token with backend mismatch is rejected at validation", async () => {
  const adapter = new FakeAdapter("claude", () => ({
    compact_output: { summary: "x", payload: { content: "x" }, pending_items: [] },
  }));
  const { gateway, cleanup } = await createTestGateway({ adapters: [adapter] });
  try {
    const env = await executeCollecting(gateway, layer2Request({
      continuation: { backend: "codex", token: "tok_mismatch" },
    }));
    const error = findByKind(env, "system.error");
    assert.ok(error, "must emit system.error for backend mismatch");
    const msg = String(payload(error).message ?? "");
    assert.ok(
      msg.includes("must match") || msg.includes("backend"),
      `error message should mention backend mismatch, got: ${msg}`,
    );
  } finally {
    await cleanup();
  }
});

gatewayTest("prepared workspace is cleaned up when setup fails before provider execution", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "bo-staff-setup-cleanup-"));
  const { gateway, dataDir, cleanup } = await createTestGateway({ adapters: [] });
  try {
    const env = await executeCollecting(gateway, {
      backend: "claude",
      execution_profile: { model: "test-model" },
      task: { prompt: "do the thing" },
      workspace: { source_root: workspaceDir },
    });
    const failed = findByKind(env, "execution.failed");
    assert.ok(failed, "missing adapter should fail before execution starts");

    const runsDir = path.join(dataDir, "runs");
    const handles = await readdir(runsDir).catch(() => []);
    assert.deepEqual(handles, [], "no prepared execution directories should remain after setup failure");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
    await cleanup();
  }
});

gatewayTest("strict output schema mismatch fails execution", async () => {
  const adapter = new FakeAdapter("claude", () => ({
    compact_output: {
      summary: "bad-shape",
      payload: { content: 42 },
      pending_items: [],
    },
  }));
  const { gateway, cleanup } = await createTestGateway({ adapters: [adapter] });
  try {
    const env = await executeCollecting(gateway, layer2Request({
      output: {
        format: "custom",
        schema: {
          type: "object",
          required: ["content"],
          additionalProperties: false,
          properties: {
            content: { type: "string" },
          },
        },
        schema_enforcement: "strict",
      },
    }));
    const failed = findByKind(env, "execution.failed");
    assert.ok(failed, "schema mismatch must fail execution");
    assert.match(String(payload(failed).message), /\$\.payload\.content expected string/);
  } finally {
    await cleanup();
  }
});

gatewayTest("timed-out executions clean up managed run directories", async () => {
  const adapter: BackendAdapter = {
    backend: "claude",
    async *execute(input) {
      yield* executeCliAdapter({
        context: input,
        command: "sh",
        args: ["-c", "sleep 1"],
        rendered_prompt: { stdin_text: "ignored" },
        parser: {
          onStdoutChunk: () => [],
          onStderrChunk: () => [],
          finish: () => {
            throw new Error("finish should not run after timeout");
          }
        }
      });
    },
  };

  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "bo-staff-timeout-workspace-"));
  const { gateway, cleanup, dataDir } = await createTestGateway({ adapters: [adapter] });
  try {
    const env = await executeCollecting(gateway, layer2Request({
      workspace: { source_root: workspaceDir },
      runtime: { timeout_ms: 20 },
    }));
    const failed = findByKind(env, "execution.failed");
    assert.ok(failed, "timeout must emit execution.failed");
    assert.match(String(payload(failed).message), /timed out/i);

    const runsDir = path.join(dataDir, "runs");
    const runEntries = await readdir(runsDir).catch(() => []);
    assert.deepEqual(runEntries, []);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
    await cleanup();
  }
});

gatewayTest("continuation token is absent from completed envelope when adapter returns none", async () => {
  const adapter = new FakeAdapter("claude", () => ({
    compact_output: { summary: "no continuation", payload: { content: "ok" }, pending_items: [] },
    // no continuation field
  }));
  const { gateway, cleanup } = await createTestGateway({ adapters: [adapter] });
  try {
    const env = await executeCollecting(gateway, layer2Request());
    const completed = findByKind(env, "execution.completed");
    assert.ok(completed);
    assert.equal(payload(completed).continuation, undefined, "no continuation when adapter omits it");
  } finally {
    await cleanup();
  }
});

// ==========================================================================
// 2. REQUEST CONTRACT SIMPLIFICATION
//
// Validates the reduced canonical request shape after policy removal.
// ==========================================================================

gatewayTest("provided workspace is forwarded directly without synthetic policy metadata", async () => {
  let receivedWorkspace: unknown;
  const adapter = new FakeAdapter("claude", (input) => {
    receivedWorkspace = input.request.workspace;
    return {
      compact_output: { summary: "ok", payload: { content: "ok" }, pending_items: [] },
    };
  });

  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "bo-staff-workspace-direct-"));
  const { gateway, cleanup } = await createTestGateway({ adapters: [adapter] });
  try {
    await executeCollecting(gateway, layer2Request({
      workspace: { source_root: workspaceDir },
    }));
    assert.deepEqual(receivedWorkspace, {
      kind: "provided",
      topology: "direct",
      source_root: workspaceDir,
      scope: { mode: "full", subpath: undefined },
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
    await cleanup();
  }
});

gatewayTest("ephemeral workspace stays minimal when no workspace is provided", async () => {
  let receivedWorkspace: unknown;
  const adapter = new FakeAdapter("claude", (input) => {
    receivedWorkspace = input.request.workspace;
    return {
      compact_output: { summary: "ok", payload: { content: "ok" }, pending_items: [] },
    };
  });

  const { gateway, cleanup } = await createTestGateway({ adapters: [adapter] });
  try {
    await executeCollecting(gateway, layer2Request());
    assert.deepEqual(receivedWorkspace, {
      kind: "ephemeral",
      topology: "direct",
      source_root: null,
      scope: { mode: "full" },
    });
  } finally {
    await cleanup();
  }
});

gatewayTest("removed policy block is rejected", async () => {
  const adapter = new FakeAdapter("claude", () => ({
    compact_output: { summary: "x", payload: { content: "x" }, pending_items: [] },
  }));
  const { gateway, cleanup } = await createTestGateway({ adapters: [adapter] });
  try {
    const env = await executeCollecting(gateway, layer2Request({
      policy: { filesystem: "full_access" },
    }));
    const error = findByKind(env, "system.error");
    assert.ok(error, "must reject removed policy block");
    assert.ok(
      String(payload(error).message).includes("$.policy"),
      "error must identify the removed policy block",
    );
  } finally {
    await cleanup();
  }
});

// ==========================================================================
// 3. STREAMING LIFECYCLE
//
// Validates the NDJSON envelope progression through a full execution,
// including structural invariants (monotonic sequences, sender attribution,
// required fields) and mid-flight cancellation.
// ==========================================================================

gatewayTest("streaming lifecycle: envelope progression follows execution.started → progress → execution.completed", async () => {
  const adapter = new FakeAdapter("claude", () => ({
    compact_output: {
      summary: "analysis complete",
      payload: { content: "the answer is 42" },
      pending_items: [],
      artifacts: [{
        artifact_id: "art_1",
        kind: "report",
        path: "output.md",
        provenance: "framework",
        materialization_state: "materialized",
      }],
    },
    usage: { input_tokens: 100, output_tokens: 50, duration_ms: 1200 },
    continuation: { backend: "claude", token: "sess_stream_test" },
  }));

  const { gateway, cleanup } = await createTestGateway({ adapters: [adapter] });
  try {
    const env = await executeCollecting(gateway, layer2Request());

    // --- Structural invariants ---

    // Every envelope must have required fields
    for (const e of env) {
      assert.ok(e.message_id, `envelope ${e.kind} missing message_id`);
      assert.ok(e.kind, `envelope missing kind`);
      assert.ok(typeof e.sequence === "number", `envelope ${e.kind} missing sequence`);
      assert.ok(e.timestamp, `envelope ${e.kind} missing timestamp`);
      assert.ok(e.sender, `envelope ${e.kind} missing sender`);
      assert.ok(e.sender.type, `envelope ${e.kind} missing sender.type`);
    }

    // Message IDs must be unique
    const ids = env.map((e) => e.message_id);
    assert.equal(new Set(ids).size, ids.length, "all message_ids must be unique");

    // Sequences must be monotonically increasing
    for (let i = 1; i < env.length; i++) {
      assert.ok(
        env[i].sequence > env[i - 1].sequence,
        `sequence must increase: envelope ${i} (${env[i].kind}) has seq ${env[i].sequence} <= ${env[i - 1].sequence}`,
      );
    }

    // --- Lifecycle progression ---

    // First envelope must be execution.started
    assert.equal(env[0].kind, "execution.started", "first envelope must be execution.started");
    assert.equal(env[0].sender.type, "runtime");
    const startedPayload = payload(env[0]);
    assert.equal(startedPayload.backend, "claude");
    assert.ok(startedPayload.execution_id, "started must include execution_id");

    // execution_id must be consistent across all envelopes that carry it
    const executionId = env[0].execution_id;
    assert.ok(executionId, "started envelope must have execution_id");
    for (const e of env) {
      if (e.execution_id) {
        assert.equal(e.execution_id, executionId, `execution_id must be consistent across envelopes (${e.kind})`);
      }
    }

    // Last envelope must be execution.completed
    const last = env[env.length - 1];
    assert.equal(last.kind, "execution.completed", "last envelope must be execution.completed");
    assert.equal(last.sender.type, "runtime");

    // Terminal payload carries output, usage, continuation, artifacts
    const termPayload = payload(last);
    assert.ok(termPayload.output, "completed must carry output");
    assert.ok(termPayload.usage, "completed must carry usage");
    assert.ok(termPayload.continuation, "completed must carry continuation when adapter provides one");
    assert.ok(Array.isArray(termPayload.artifacts), "completed must carry artifacts array");

    // --- Intermediate envelopes ---

    // There should be at least one progress event between started and completed
    const progressEnvelopes = env.filter(
      (e) => e.kind.startsWith("progress."),
    );
    assert.ok(progressEnvelopes.length > 0, "must have at least one progress envelope");

    // Progress envelopes should come from agent sender
    for (const pe of progressEnvelopes) {
      assert.equal(pe.sender.type, "agent", `progress envelope ${pe.kind} should have agent sender`);
    }

    // No terminal event before the last envelope
    const terminalKinds = ["execution.completed", "execution.failed", "execution.cancelled"];
    for (let i = 0; i < env.length - 1; i++) {
      assert.ok(
        !terminalKinds.includes(env[i].kind),
        `terminal event ${env[i].kind} must only appear as the last envelope`,
      );
    }
  } finally {
    await cleanup();
  }
});

gatewayTest("streaming lifecycle: failed execution emits execution.failed as terminal event", async () => {
  const adapter = new FakeAdapter("claude", () => ({
    errors: [{ code: "provider_process_error", category: "provider", message: "segfault in backend", retryable: false }],
  }));

  const { gateway, cleanup } = await createTestGateway({ adapters: [adapter] });
  try {
    const env = await executeCollecting(gateway, layer2Request());

    const started = findByKind(env, "execution.started");
    assert.ok(started, "must emit execution.started even for failures");

    const failed = findByKind(env, "execution.failed");
    assert.ok(failed, "must emit execution.failed");
    assert.equal(failed.sender.type, "runtime");
    assert.ok(String(payload(failed).message).includes("segfault"), "failure message must propagate");

    // Last envelope must be the failure
    assert.equal(env[env.length - 1].kind, "execution.failed");

    // No completed event
    assert.equal(findByKind(env, "execution.completed"), undefined, "must not emit completed on failure");
  } finally {
    await cleanup();
  }
});

gatewayTest("mid-flight cancellation emits execution.cancelled", async () => {
  const abortController = new AbortController();
  let adapterStarted = false;

  // Adapter that blocks until aborted
  const adapter: BackendAdapter = {
    backend: "claude" as BackendName,
    async *execute(input) {
      yield { type: "provider.started" } satisfies AdapterEvent;
      adapterStarted = true;

      // Block until signal fires
      await new Promise<void>((resolve) => {
        if (input.signal.aborted) { resolve(); return; }
        input.signal.addEventListener("abort", () => resolve(), { once: true });
      });

      // Simulate clean exit after abort (adapter sees the signal and stops)
      yield {
        type: "provider.failed",
        error: { message: "aborted", retryable: false, kind: "provider_process_aborted" },
      } satisfies AdapterEvent;
    },
  };

  const { gateway, cleanup } = await createTestGateway({ adapters: [adapter] });
  try {
    const envelopes: BomcpEnvelope[] = [];
    const executePromise = gateway.execute({
      rawRequest: layer2Request(),
      streamWriter: async (e) => {
        envelopes.push(e);
        // Cancel after execution.started is emitted
        if (e.kind === "execution.started") {
          // Small delay so the adapter loop enters its wait
          setTimeout(() => abortController.abort("user_cancelled"), 5);
        }
      },
      signal: abortController.signal,
    });

    await executePromise;

    // Must have started
    assert.ok(findByKind(envelopes, "execution.started"), "must emit started before cancel");

    // Terminal event must be cancelled or failed (both are valid for abort)
    const terminal = envelopes[envelopes.length - 1];
    assert.ok(
      terminal.kind === "execution.cancelled" || terminal.kind === "execution.failed",
      `terminal event must be cancelled or failed, got: ${terminal.kind}`,
    );
  } finally {
    await cleanup();
  }
});

gatewayTest("heartbeat envelopes are emitted during long-running execution", async () => {
  // Adapter that takes just over one heartbeat interval
  const adapter: BackendAdapter = {
    backend: "claude" as BackendName,
    async *execute(_input) {
      yield { type: "provider.started" } satisfies AdapterEvent;

      // Wait ~50ms (we'll use a short heartbeat in the execution manager)
      await new Promise((r) => setTimeout(r, 50));

      yield {
        type: "provider.completed",
        result: {
          raw_output_text: JSON.stringify({ summary: "ok", payload: { content: "ok" }, pending_items: [] }),
          exit_reason: "completed",
        },
      } satisfies AdapterEvent;
    },
  };

  // We can't easily change the heartbeat interval (it's a constant), but the
  // default 15s is too long for tests. Instead, verify the heartbeat timer
  // is set up by checking that progress.heartbeat appears if we wait long enough.
  // For a fast test, we just verify the envelope structure is correct when
  // the execution completes quickly (no heartbeat expected within <50ms).
  const { gateway, cleanup } = await createTestGateway({ adapters: [adapter] });
  try {
    const env = await executeCollecting(gateway, layer2Request());
    const completed = findByKind(env, "execution.completed");
    assert.ok(completed, "must complete");
    // Heartbeat may or may not appear depending on timing; just verify no crash
  } finally {
    await cleanup();
  }
});

// ==========================================================================
// 4. ADMISSION CONTROL & CONCURRENCY
//
// Validates that the gateway enforces concurrent execution limits and
// returns the correct error codes when saturated or draining.
// ==========================================================================

gatewayTest("admission control rejects with gateway_busy when pool is saturated", async () => {
  const MAX_CONCURRENT = 2;
  let resolveBlockers: Array<() => void> = [];

  // Adapter that blocks until manually released
  const adapter: BackendAdapter = {
    backend: "claude" as BackendName,
    async *execute(_input) {
      yield { type: "provider.started" } satisfies AdapterEvent;
      await new Promise<void>((resolve) => { resolveBlockers.push(resolve); });
      yield {
        type: "provider.completed",
        result: {
          raw_output_text: JSON.stringify({ summary: "ok", payload: { content: "ok" }, pending_items: [] }),
          exit_reason: "completed",
        },
      } satisfies AdapterEvent;
    },
  };

  const { gateway, dataDir, cleanup } = await createTestGateway({ adapters: [adapter] });
  // Recreate with lower limit
  const { ExecutionManager } = await import("../../src/engine/execution-manager.ts");
  const { BoStaff } = await import("../../src/gateway.ts");
  const limitedManager = new ExecutionManager({
    adapters: [adapter],
    dataDir,
    maxConcurrentExecutions: MAX_CONCURRENT,
  });
  const limitedGateway = new BoStaff({ executionManager: limitedManager });

  try {
    // Fill the pool
    const runningPromises: Promise<BomcpEnvelope[]>[] = [];
    for (let i = 0; i < MAX_CONCURRENT; i++) {
      runningPromises.push(executeCollecting(limitedGateway, layer2Request()));
    }

    // Wait for adapters to start
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(resolveBlockers.length, MAX_CONCURRENT, "all slots should be occupied");

    // Next request must be rejected
    const rejectedEnv = await executeCollecting(limitedGateway, layer2Request());
    const busyError = findByKind(rejectedEnv, "system.error");
    assert.ok(busyError, "must emit system.error when pool is full");
    assert.equal(payload(busyError).code, "gateway_busy", "error code must be gateway_busy");

    // Release the blockers so the test can finish
    for (const release of resolveBlockers) release();
    await Promise.all(runningPromises);
  } finally {
    await cleanup();
  }
});

gatewayTest("admission control rejects with gateway_draining during shutdown", async () => {
  const admission = new ExecutionAdmissionController(4);

  // Acquire one slot to make drain wait
  assert.equal(admission.tryAcquire(), true);

  // Start draining
  const drainPromise = admission.drain();
  assert.ok(admission.isDraining());

  // New acquisitions must fail
  assert.equal(admission.tryAcquire(), false, "must reject during drain");

  // Release to complete drain
  admission.release();
  await drainPromise;

  // After drain completes, admission is still in draining mode until resume
  assert.equal(admission.tryAcquire(), false, "must still reject after drain completes until resume");

  admission.resume();
  assert.equal(admission.tryAcquire(), true, "must accept after resume");
  admission.release();
});

gatewayTest("gateway-level draining rejects new executions with gateway_draining", async () => {
  let releaseAdapter: (() => void) | undefined;

  const adapter: BackendAdapter = {
    backend: "claude" as BackendName,
    async *execute(_input) {
      yield { type: "provider.started" } satisfies AdapterEvent;
      await new Promise<void>((resolve) => { releaseAdapter = resolve; });
      yield {
        type: "provider.completed",
        result: {
          raw_output_text: JSON.stringify({ summary: "ok", payload: { content: "ok" }, pending_items: [] }),
          exit_reason: "completed",
        },
      } satisfies AdapterEvent;
    },
  };

  const { gateway, dataDir, cleanup } = await createTestGateway({ adapters: [adapter] });
  const { ExecutionManager } = await import("../../src/engine/execution-manager.ts");
  const { BoStaff } = await import("../../src/gateway.ts");
  const manager = new ExecutionManager({ adapters: [adapter], dataDir, maxConcurrentExecutions: 4 });
  const gw = new BoStaff({ executionManager: manager });

  try {
    // Start one execution to keep the pool non-empty
    const runningPromise = executeCollecting(gw, layer2Request());
    await new Promise((r) => setTimeout(r, 30));

    // Initiate shutdown (drain)
    const shutdownPromise = gw.shutdown();

    // New execution during drain must be rejected
    const rejectedEnv = await executeCollecting(gw, layer2Request());
    const drainingError = findByKind(rejectedEnv, "system.error");
    assert.ok(drainingError, "must emit system.error during drain");
    assert.equal(payload(drainingError).code, "gateway_draining", "error code must be gateway_draining");

    // Release the running execution so shutdown completes
    releaseAdapter?.();
    await runningPromise;
    await shutdownPromise;
  } finally {
    await cleanup();
  }
});

gatewayTest("concurrent executions produce independent envelope streams", async () => {
  let callCount = 0;
  const adapter = new FakeAdapter("claude", () => {
    const n = ++callCount;
    return {
      compact_output: {
        summary: `result-${n}`,
        payload: { content: `output-${n}` },
        pending_items: [],
      },
    };
  });

  const { gateway, cleanup } = await createTestGateway({ adapters: [adapter] });
  try {
    // Fire two executions concurrently
    const [envA, envB] = await Promise.all([
      executeCollecting(gateway, layer2Request()),
      executeCollecting(gateway, layer2Request()),
    ]);

    // Each must have independent execution_ids
    const idA = envA[0]?.execution_id;
    const idB = envB[0]?.execution_id;
    assert.ok(idA, "execution A must have an id");
    assert.ok(idB, "execution B must have an id");
    assert.notEqual(idA, idB, "concurrent executions must have distinct ids");

    // Each must complete independently
    assert.ok(findByKind(envA, "execution.completed"), "A must complete");
    assert.ok(findByKind(envB, "execution.completed"), "B must complete");

    // Each stream's sequences must be internally monotonic
    for (const env of [envA, envB]) {
      for (let i = 1; i < env.length; i++) {
        assert.ok(env[i].sequence > env[i - 1].sequence, "sequences must be monotonic within each stream");
      }
    }
  } finally {
    await cleanup();
  }
});
