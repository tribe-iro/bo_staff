import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { buildCodexExecArgs } from "../../src/adapters/codex/adapter.ts";
import { createTestGateway, FakeAdapter } from "./fixtures.ts";

const MESSAGE_SCHEMA = {
  type: "object",
  required: ["content"],
  additionalProperties: false,
  properties: {
    content: { type: "string" }
  }
} as const;

test("managed continuation persists framework memory across backend changes", async () => {
  const codex = new FakeAdapter("codex", ({ execution_id }) => ({
    provider_session_id: `provider-${execution_id}`,
    compact_output: {
      summary: "seeded",
      payload: { content: "hello", remembered_token: "tok-123" },
      pending_items: [],
      artifacts: []
    }
  }));
  const claude = new FakeAdapter("claude", ({ prompt }) => {
    assert.match(prompt, /remembered_token: tok-123/);
    return {
      compact_output: {
        summary: "continued",
        payload: { content: "world" },
        pending_items: [],
        artifacts: []
      }
    };
  });
  const harness = await createTestGateway({ adapters: [codex, claude] });
  try {
    const workspaceRoot = path.join(harness.dataDir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });

    const first = await harness.gateway.execute({
      backend: "codex",
      task: { prompt: "say hello" },
      session: { mode: "new" },
      workspace: { source_root: workspaceRoot },
      output: {
        format: "message",
        schema: {
          type: "object",
          required: ["content", "remembered_token"],
          additionalProperties: false,
          properties: {
            content: { type: "string" },
            remembered_token: { type: "string" }
          }
        }
      }
    }, "req_1");

    const second = await harness.gateway.execute({
      backend: "claude",
      task: { prompt: "continue" },
      session: { mode: "continue", handle: first.body.session.handle },
      workspace: { source_root: workspaceRoot },
      output: { format: "message", schema: MESSAGE_SCHEMA }
    }, "req_2");

    assert.equal(second.httpStatus, 200);
    assert.equal(second.body.session.continuity_kind, "managed");
    assert.equal((second.body.result.payload as { content: string }).content, "world");
  } finally {
    await harness.cleanup();
  }
});

test("continue mode keeps the same session handle for native continuation", async () => {
  const codex = new FakeAdapter("codex", ({ execution_id, session }) => ({
    provider_session_id: session.provider_session_id ?? `provider-${execution_id}`,
    compact_output: {
      summary: "done",
      payload: { content: "hello" },
      pending_items: [],
      artifacts: []
    }
  }));
  const harness = await createTestGateway({ adapters: [codex] });
  try {
    const workspaceRoot = path.join(harness.dataDir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });

    const first = await harness.gateway.execute({
      backend: "codex",
      task: { prompt: "seed" },
      session: { mode: "new" },
      workspace: { source_root: workspaceRoot },
      output: { format: "message", schema: MESSAGE_SCHEMA }
    }, "req_native_1");

    const second = await harness.gateway.execute({
      backend: "codex",
      task: { prompt: "continue" },
      session: { mode: "continue", handle: first.body.session.handle },
      workspace: { source_root: workspaceRoot },
      output: { format: "message", schema: MESSAGE_SCHEMA }
    }, "req_native_2");

    assert.equal(second.httpStatus, 200);
    assert.equal(second.body.session.handle, first.body.session.handle);
    assert.equal(second.body.session.continuity_kind, "native");
    assert.equal(second.body.session.continued_from, first.body.session.handle);
  } finally {
    await harness.cleanup();
  }
});

test("changing workspace identity downgrades continuation to managed", async () => {
  const codex = new FakeAdapter("codex", ({ execution_id, session }) => ({
    provider_session_id: session.provider_session_id ?? `provider-${execution_id}`,
    compact_output: {
      summary: "done",
      payload: { content: "hello" },
      pending_items: [],
      artifacts: []
    }
  }));
  const harness = await createTestGateway({ adapters: [codex] });
  try {
    const workspaceRootA = path.join(harness.dataDir, "workspace-a");
    const workspaceRootB = path.join(harness.dataDir, "workspace-b");
    await mkdir(workspaceRootA, { recursive: true });
    await mkdir(workspaceRootB, { recursive: true });

    const first = await harness.gateway.execute({
      backend: "codex",
      task: { prompt: "seed" },
      session: { mode: "new" },
      workspace: { source_root: workspaceRootA },
      output: { format: "message", schema: MESSAGE_SCHEMA }
    }, "req_workspace_identity_1");

    const second = await harness.gateway.execute({
      backend: "codex",
      task: { prompt: "continue elsewhere" },
      session: { mode: "continue", handle: first.body.session.handle },
      workspace: { source_root: workspaceRootB },
      output: { format: "message", schema: MESSAGE_SCHEMA }
    }, "req_workspace_identity_2");

    assert.equal(second.httpStatus, 200);
    assert.equal(second.body.session.continuity_kind, "managed");
  } finally {
    await harness.cleanup();
  }
});

test("workspace isolation policy requires an isolate-able workspace", async () => {
  const harness = await createTestGateway({
    adapters: [
      new FakeAdapter("codex", async () => {
        throw new Error("should not execute");
      })
    ]
  });
  try {
    const workspaceRoot = path.join(harness.dataDir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const result = await harness.gateway.execute({
      backend: "codex",
      task: { prompt: "x" },
      session: { mode: "ephemeral" },
      workspace: { source_root: workspaceRoot },
      policy: {
        isolation: "require_workspace_isolation"
      },
      output: { schema: { type: "object" } }
    }, "req_direct");

    assert.equal(result.httpStatus, 400);
    assert.equal(result.body.execution.status, "rejected");
    assert.match(result.body.errors[0].message, /git repository/);
  } finally {
    await harness.cleanup();
  }
});

test("ephemeral sessions degrade durable continuation descriptively", async () => {
  const harness = await createTestGateway({
    adapters: [
      new FakeAdapter("codex", () => ({
        compact_output: {
          summary: "done",
          payload: { content: "ok" },
          pending_items: [],
          artifacts: []
        }
      }))
    ]
  });
  try {
    const workspaceRoot = path.join(harness.dataDir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const result = await harness.gateway.execute({
      backend: "codex",
      task: { prompt: "x" },
      session: { mode: "ephemeral" },
      workspace: { source_root: workspaceRoot },
      output: { schema: MESSAGE_SCHEMA }
    }, "req_ephemeral");

    assert.equal(result.httpStatus, 200);
    assert.equal(result.body.capabilities.durable_continuation.status, "degraded");
  } finally {
    await harness.cleanup();
  }
});

test("claude read_only policy degrades explicitly instead of rejecting the request", async () => {
  const harness = await createTestGateway({
    adapters: [
      new FakeAdapter("claude", () => ({
        compact_output: {
          summary: "done",
          payload: { content: "ok" },
          pending_items: [],
          artifacts: []
        }
      }))
    ]
  });
  try {
    const workspaceRoot = path.join(harness.dataDir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const result = await harness.gateway.execute({
      backend: "claude",
      task: { prompt: "x" },
      session: { mode: "ephemeral" },
      workspace: { source_root: workspaceRoot },
      policy: {
        filesystem: "read_only"
      },
      output: { schema: MESSAGE_SCHEMA }
    }, "req_claude_read_only");

    assert.equal(result.httpStatus, 200);
    assert.equal(result.body.execution.status, "completed");
    assert.equal(result.body.capabilities.policy_enforcement.status, "degraded");
    assert.match(result.body.capabilities.policy_enforcement.reason ?? "", /Claude/);
  } finally {
    await harness.cleanup();
  }
});

test("claude default filesystem policy reports the same read-only enforcement gap as explicit read_only", async () => {
  const harness = await createTestGateway({
    adapters: [
      new FakeAdapter("claude", () => ({
        compact_output: {
          summary: "done",
          payload: { content: "ok" },
          pending_items: [],
          artifacts: []
        }
      }))
    ]
  });
  try {
    const workspaceRoot = path.join(harness.dataDir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });

    const explicit = await harness.gateway.execute({
      backend: "claude",
      task: { prompt: "x" },
      session: { mode: "ephemeral" },
      workspace: { source_root: workspaceRoot },
      policy: {
        filesystem: "read_only"
      },
      output: { schema: MESSAGE_SCHEMA }
    }, "req_claude_read_only_explicit");

    const implicit = await harness.gateway.execute({
      backend: "claude",
      task: { prompt: "x" },
      session: { mode: "ephemeral" },
      workspace: { source_root: workspaceRoot },
      output: { schema: MESSAGE_SCHEMA }
    }, "req_claude_read_only_default");

    assert.equal(explicit.httpStatus, 200);
    assert.equal(implicit.httpStatus, 200);
    assert.equal(explicit.body.capabilities.policy_enforcement.status, "degraded");
    assert.equal(implicit.body.capabilities.policy_enforcement.status, "degraded");
    assert.equal(
      implicit.body.capabilities.policy_enforcement.reason,
      explicit.body.capabilities.policy_enforcement.reason
    );
  } finally {
    await harness.cleanup();
  }
});

test("codex command args use stdin prompt transport and policy-derived approvals", () => {
  const args = buildCodexExecArgs({
    request_id: "req",
    execution_id: "exec",
    signal: new AbortController().signal,
    request: {
      backend: "codex",
      execution_profile: {
        performance_tier: "balanced",
        reasoning_tier: "standard",
        selection_mode: "managed"
      },
      runtime: {
        timeout_ms: 30_000
      },
      task: {
        prompt: "secret prompt",
        context: {},
        attachments: [],
        constraints: []
      },
      session: {
        mode: "ephemeral",
        handle: null
      },
      workspace: {
        kind: "provided",
        topology: "direct",
        source_root: "/tmp/project",
        scope: { mode: "full" },
        writeback: "apply",
        sandbox: "workspace-write"
      },
      policy: {
        isolation: "default",
        approvals: "forbid_interactive_approvals",
        filesystem: "workspace_write"
      },
      output: {
        format: "message",
        schema: MESSAGE_SCHEMA
      },
      hints: {},
      metadata: {}
    },
    execution_profile: {
      requested_performance_tier: "balanced",
      requested_reasoning_tier: "standard",
      selection_mode: "managed",
      resolved_backend_model: "gpt-5",
      resolution_source: "managed"
    },
    session: {
      internal_handle: "sess",
      public_handle: null,
      persist_on_initialize: false,
      continuity_kind: "none",
      durability_kind: "ephemeral"
    },
    workspace: {
      topology: "direct",
      source_root: "/tmp/project",
      runtime_working_directory: "/tmp/project",
      run_dir: "/tmp/project/run",
      scope_status: "unbounded",
      writeback_status: "not_requested",
      materialization_status: "not_requested"
    },
    prompt: "secret prompt"
  }, "/tmp/project/last.json");

  assert.ok(!args.includes("secret prompt"));
  assert.ok(args.some((entry) => entry.includes("approval_policy=\"never\"")));
});
