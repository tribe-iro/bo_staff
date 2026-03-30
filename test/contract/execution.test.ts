import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { buildCodexExecArgs } from "../../src/adapters/codex/adapter.ts";
import { buildClaudeExecArgs } from "../../src/adapters/claude/adapter.ts";
import { createTestGateway, FakeAdapter } from "./fixtures.ts";

const CODEX_PROFILE = { model: "gpt-5" } as const;
const CLAUDE_PROFILE = { model: "claude-sonnet-4" } as const;
const MESSAGE_SCHEMA = {
  type: "object",
  required: ["content"],
  additionalProperties: false,
  properties: {
    content: { type: "string" }
  }
} as const;

function flattenPrompt(input: {
  system: { sections: Array<{ content: string }> };
  user: { sections: Array<{ content: string }> };
}): string {
  return [...input.system.sections, ...input.user.sections].map((section) => section.content).join("\n\n");
}

test("codex command args use stdin prompt transport and fully permissive provider flags", async () => {
  const args = await buildCodexExecArgs({
    request_id: "req",
    execution_id: "exec",
    signal: new AbortController().signal,
    request: {
      backend: "codex",
      execution_profile: {
        model: "gpt-5",
        reasoning_effort: "medium"
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
      workspace: {
        kind: "provided",
        topology: "direct",
        source_root: "/tmp/project",
        scope: { mode: "full" },
      },
      output: {
        format: "message",
        schema: MESSAGE_SCHEMA,
        schema_enforcement: "advisory"
      },
      metadata: {}
    },
    execution_profile: {
      model: "gpt-5",
      reasoning_effort: "medium"
    },
    workspace: {
      topology: "direct",
      source_root: "/tmp/project",
      runtime_working_directory: "/tmp/project",
      run_dir: "/tmp/project/run",
      scope_status: "unbounded"
    },
    prompt: {
      system: { sections: [] },
      user: {
        sections: [{ label: "task_prompt", content: "Task prompt:\nsecret prompt" }],
        attachments: []
      }
    }
  }, "/tmp/project/last.json");

  assert.ok(!args.includes("secret prompt"));
  assert.ok(args.includes("--model"));
  assert.ok(args.includes("gpt-5"));
  assert.ok(args.some((entry) => entry.includes("model_reasoning_effort=\"medium\"")));
  assert.ok(args.some((entry) => entry.includes('sandbox_mode="danger-full-access"')));
  assert.ok(args.some((entry) => entry.includes("approval_policy=\"never\"")));
});

test("codex command args inject MCP servers via config overrides", async () => {
  const args = await buildCodexExecArgs({
    request_id: "req",
    execution_id: "exec",
    signal: new AbortController().signal,
    request: {
      backend: "codex",
      execution_profile: {
        model: "gpt-5",
        reasoning_effort: "medium"
      },
      runtime: {
        timeout_ms: 30_000
      },
      task: {
        prompt: "use mcp",
        context: {},
        attachments: [],
        constraints: []
      },
      workspace: {
        kind: "provided",
        topology: "direct",
        source_root: "/tmp/project",
        scope: { mode: "full" },
      },
      output: {
        format: "message",
        schema: MESSAGE_SCHEMA,
        schema_enforcement: "advisory"
      },
      tool_configuration: {
        builtin_policy: { mode: "default" },
        mcp_servers: [{
          name: "docs",
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          env: { DOCS_TOKEN: "abc" },
          require_approval: "never",
        }]
      },
      metadata: {}
    },
    execution_profile: {
      model: "gpt-5",
      reasoning_effort: "medium"
    },
    workspace: {
      topology: "direct",
      source_root: "/tmp/project",
      runtime_working_directory: "/tmp/project",
      run_dir: "/tmp/project/run",
      scope_status: "unbounded"
    },
    bomcp_server_config: {
      command: "node",
      args: ["/tmp/bomcp-server.js"],
      env: { BO_MCP_EXECUTION_ID: "exec_1", BO_MCP_IPC_ADDRESS: "/tmp/bomcp.sock" }
    },
    prompt: {
      system: { sections: [] },
      user: {
        sections: [{ label: "task_prompt", content: "Task prompt:\nuse mcp" }],
        attachments: []
      }
    }
  }, "/tmp/project/last.json");

  assert.ok(args.includes("-c"));
  assert.ok(args.some((entry) => entry === 'mcp_servers.docs.command="node"'));
  assert.ok(args.some((entry) => entry === 'mcp_servers.docs.args=["server.js"]'));
  assert.ok(args.some((entry) => entry === 'mcp_servers.docs.env={DOCS_TOKEN="abc"}'));
  assert.ok(args.some((entry) => entry === 'mcp_servers.docs.require_approval="never"'));
  assert.ok(args.some((entry) => entry === 'mcp_servers.bomcp.command="node"'));
  assert.ok(args.some((entry) => entry === 'mcp_servers.bomcp.args=["/tmp/bomcp-server.js"]'));
  assert.ok(args.some((entry) => entry.includes('mcp_servers.bomcp.env={')));
  assert.ok(args.some((entry) => entry === 'mcp_servers.bomcp.require_approval="never"'));
  assert.ok(!args.some((entry) => entry.includes("mcp_config_path")));
});

test("claude command args preserve model, reasoning, resume, schema, tool policy, and MCP config", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "bo-staff-claude-args-"));
  try {
    const args = await buildClaudeExecArgs({
      request_id: "req",
      execution_id: "exec",
      signal: new AbortController().signal,
      request: {
        backend: "claude",
        execution_profile: {
          model: "claude-sonnet-4-6",
          reasoning_effort: "high"
        },
        runtime: {
          timeout_ms: 30_000
        },
        task: {
          prompt: "use mcp",
          context: {},
          attachments: [],
          constraints: []
        },
        continuation: {
          backend: "claude",
          token: "sess_resume_123"
        },
        workspace: {
          kind: "provided",
          topology: "direct",
          source_root: "/tmp/project",
          scope: { mode: "full" }
        },
        output: {
          format: "custom",
          schema: MESSAGE_SCHEMA,
          schema_enforcement: "strict"
        },
        tool_configuration: {
          builtin_policy: { mode: "allowlist", tools: ["Read", "Write"] },
          mcp_servers: [{
            name: "docs",
            transport: "stdio",
            command: "node",
            args: ["server.js"],
            env: { DOCS_TOKEN: "abc" },
          }]
        },
        metadata: {}
      },
      execution_profile: {
        model: "claude-sonnet-4-6",
        reasoning_effort: "high"
      },
      continuation: {
        backend: "claude",
        token: "sess_resume_123"
      },
      workspace: {
        topology: "direct",
        source_root: "/tmp/project",
        runtime_working_directory: "/tmp/project",
        run_dir: runDir,
        scope_status: "unbounded"
      },
      bomcp_server_config: {
        command: "node",
        args: ["/tmp/bomcp-server.js"],
        env: { BO_MCP_EXECUTION_ID: "exec_1", BO_MCP_IPC_ADDRESS: "/tmp/bomcp.sock" }
      },
      prompt: {
        system: { sections: [] },
        user: {
          sections: [{ label: "task_prompt", content: "Task prompt:\nuse mcp" }],
          attachments: []
        }
      }
    });

    assert.deepEqual(args.slice(0, 6), [
      "-p",
      "--output-format", "json",
      "--permission-mode", "bypassPermissions",
      "--model"
    ]);
    assert.ok(args.includes("claude-sonnet-4-6"));
    assert.ok(args.includes("--effort"));
    assert.ok(args.includes("high"));
    assert.ok(args.includes("--resume"));
    assert.ok(args.includes("sess_resume_123"));
    assert.ok(args.includes("--allowedTools"));
    assert.ok(args.includes("Read,Write"));
    assert.ok(args.includes("--json-schema"));
    assert.ok(args.includes(JSON.stringify(MESSAGE_SCHEMA)));
    assert.ok(args.includes("--mcp-config"));

    const configPath = args[args.indexOf("--mcp-config") + 1];
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      mcpServers: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
    };
    assert.deepEqual(config.mcpServers.docs, {
      command: "node",
      args: ["server.js"],
      env: { DOCS_TOKEN: "abc" }
    });
    assert.deepEqual(config.mcpServers.bomcp, {
      command: "node",
      args: ["/tmp/bomcp-server.js"],
      env: { BO_MCP_EXECUTION_ID: "exec_1", BO_MCP_IPC_ADDRESS: "/tmp/bomcp.sock" }
    });
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
