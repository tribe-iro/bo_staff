import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { normalizeAndValidateRequest } from "../../src/validation.ts";
import { DEFAULT_EXECUTION_TIMEOUT_MS } from "../../src/config/defaults.ts";

const CODEX_PROFILE = { model: "gpt-5" } as const;

test("requires execution_profile.model and rejects removed top-level fields", async () => {
  const missingModel = await normalizeAndValidateRequest({
    backend: "codex",
    execution_profile: {},
    task: { prompt: "x" },
    workspace: { source_root: os.tmpdir() },
    output: { schema: { type: "object" } }
  });

  assert.equal(missingModel.ok, false);
  assert.match(missingModel.issues.map((issue) => issue.path).join("; "), /\$\.execution_profile\.model/);

  const removedField = await normalizeAndValidateRequest({
    backend: "codex",
    execution_profile: CODEX_PROFILE,
    task: { prompt: "x" },
    workspace: { source_root: os.tmpdir() },
    output: { schema: { type: "object" } },
    collaboration: { mode: "delegate" }
  });

  assert.equal(removedField.ok, false);
  assert.match(removedField.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "), /\$\.collaboration/);
});

test("validates attachments must define exactly one content source", async () => {
  const result = await normalizeAndValidateRequest({
    backend: "codex",
    execution_profile: CODEX_PROFILE,
    task: {
      prompt: "x",
      attachments: [
        {
          name: "bad",
          path: "/tmp/a",
          content: "also bad"
        }
      ]
    },
    workspace: { source_root: os.tmpdir() },
    output: { schema: { type: "object" } }
  });

  assert.equal(result.ok, false);
  assert.match(result.issues.map((issue) => issue.message).join("; "), /exactly one of path or content/);
});

test("rejects empty task.objective", async () => {
  const result = await normalizeAndValidateRequest({
    backend: "codex",
    execution_profile: CODEX_PROFILE,
    task: { prompt: "x", objective: "   " },
    workspace: { source_root: os.tmpdir() },
    output: { schema: { type: "object" } }
  });

  assert.equal(result.ok, false);
  assert.match(result.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "), /\$\.task\.objective .*non-empty string/);
});

test("rejects invalid attachment mime types", async () => {
  const result = await normalizeAndValidateRequest({
    backend: "codex",
    execution_profile: CODEX_PROFILE,
    task: {
      prompt: "x",
      attachments: [
        {
          name: "bad-mime",
          content: "hello",
          mime_type: "not a mime type"
        }
      ]
    },
    workspace: { source_root: os.tmpdir() },
    output: { schema: { type: "object" } }
  });

  assert.equal(result.ok, false);
  assert.match(result.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "), /\$\.task\.attachments\[0\]\.mime_type .*valid MIME type/);
});

test("restricts attachment paths to the effective workspace scope", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "bo-staff-validation-"));
  const insidePath = path.join(workspaceRoot, "allowed.txt");
  const outsidePath = path.join(os.tmpdir(), "bo-staff-validation-outside.txt");
  await writeFile(insidePath, "ok", "utf8");
  await writeFile(outsidePath, "nope", "utf8");

  try {
    const inside = await normalizeAndValidateRequest({
      backend: "codex",
      execution_profile: CODEX_PROFILE,
      task: {
        prompt: "x",
        attachments: [
          {
            name: "inside",
            path: "./allowed.txt"
          }
        ]
      },
      workspace: { source_root: workspaceRoot },
      output: { schema: { type: "object" } }
    });

    assert.equal(inside.ok, true);
    if (!inside.ok) {
      throw new Error("expected normalized request");
    }
    assert.equal(inside.value.task.attachments[0]?.kind, "path");
    if (inside.value.task.attachments[0]?.kind !== "path") {
      throw new Error("expected path attachment");
    }
    assert.equal(inside.value.task.attachments[0].path, insidePath);

    const outside = await normalizeAndValidateRequest({
      backend: "codex",
      execution_profile: CODEX_PROFILE,
      task: {
        prompt: "x",
        attachments: [
          {
            name: "outside",
            path: outsidePath
          }
        ]
      },
      workspace: { source_root: workspaceRoot },
      output: { schema: { type: "object" } }
    });

    assert.equal(outside.ok, false);
    assert.match(outside.issues.map((issue) => issue.message).join("; "), /effective workspace scope/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsidePath, { force: true });
  }
});

test("rejects attachment paths that escape workspace scope through symlinks", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "bo-staff-validation-symlink-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "bo-staff-validation-symlink-outside-"));
  const outsidePath = path.join(outsideRoot, "secret.txt");
  const symlinkPath = path.join(workspaceRoot, "escape.txt");
  await writeFile(outsidePath, "secret", "utf8");
  await symlink(outsidePath, symlinkPath);

  try {
    const result = await normalizeAndValidateRequest({
      backend: "codex",
      execution_profile: CODEX_PROFILE,
      task: {
        prompt: "x",
        attachments: [
          {
            name: "escape",
            path: "./escape.txt"
          }
        ]
      },
      workspace: { source_root: workspaceRoot },
      output: { schema: { type: "object" } }
    });

    assert.equal(result.ok, false);
    assert.match(result.issues.map((issue) => issue.message).join("; "), /symlink resolution/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("reports missing scoped workspace subpaths as missing instead of symlink escape", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "bo-staff-validation-missing-scope-"));
  try {
    const result = await normalizeAndValidateRequest({
      backend: "codex",
      execution_profile: CODEX_PROFILE,
      task: { prompt: "x" },
      workspace: {
        source_root: workspaceRoot,
        scope: {
          mode: "subpath",
          subpath: "does-not-exist"
        }
      },
      output: { schema: { type: "object" } }
    });

    assert.equal(result.ok, false);
    assert.match(result.issues.map((issue) => issue.message).join("; "), /must exist and be readable/);
    assert.doesNotMatch(result.issues.map((issue) => issue.message).join("; "), /symlink resolution/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("defaults runtime timeout from the substrate default and rejects invalid explicit values", async () => {
  const sourceRoot = os.tmpdir();

  const defaulted = await normalizeAndValidateRequest({
    backend: "codex",
    execution_profile: CODEX_PROFILE,
    task: { prompt: "x" },
    workspace: { source_root: sourceRoot },
    output: { schema: { type: "object" } }
  });

  assert.equal(defaulted.ok, true);
  if (!defaulted.ok) {
    throw new Error("expected normalized request");
  }
  assert.equal(defaulted.value.runtime.timeout_ms, DEFAULT_EXECUTION_TIMEOUT_MS);

  const invalid = await normalizeAndValidateRequest({
    backend: "codex",
    execution_profile: CODEX_PROFILE,
    runtime: {
      timeout_ms: "five minutes"
    },
    task: { prompt: "x" },
    workspace: { source_root: sourceRoot },
    output: { schema: { type: "object" } }
  });

  assert.equal(invalid.ok, false);
  assert.match(invalid.issues.map((issue) => issue.path).join("; "), /\$\.runtime\.timeout_ms/);
});

test("rejects removed policy and sandbox controls", async () => {
  const removedPolicy = await normalizeAndValidateRequest({
    backend: "codex",
    execution_profile: CODEX_PROFILE,
    task: { prompt: "x" },
    workspace: { source_root: os.tmpdir() },
    policy: {
      filesystem: "full_access"
    },
    output: { schema: { type: "object" } }
  });

  assert.equal(removedPolicy.ok, false);
  assert.match(
    removedPolicy.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "),
    /\$\.policy .*removed/
  );

  const removedSandbox = await normalizeAndValidateRequest({
    backend: "codex",
    execution_profile: CODEX_PROFILE,
    task: { prompt: "x" },
    workspace: { source_root: os.tmpdir() },
    output: { schema: { type: "object" } },
    isolation: "git_worktree"
  });

  assert.equal(removedSandbox.ok, false);
  assert.match(
    removedSandbox.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "),
    /\$\.isolation .*removed/
  );
});

test("defaults message output.schema when output.format=message omits it", async () => {
  const result = await normalizeAndValidateRequest({
    backend: "codex",
    execution_profile: CODEX_PROFILE,
    task: { prompt: "x" },
    workspace: { source_root: os.tmpdir() },
    output: {
      format: "message"
    }
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("expected normalized request");
  }
  assert.equal(result.value.output.format, "message");
  assert.equal(result.value.output.schema.type, "object");
});

test("requires output.schema when output.format=custom", async () => {
  const result = await normalizeAndValidateRequest({
    backend: "codex",
    execution_profile: CODEX_PROFILE,
    task: { prompt: "x" },
    workspace: { source_root: os.tmpdir() },
    output: {
      format: "custom"
    }
  });

  assert.equal(result.ok, false);
  assert.match(result.issues.map((issue) => issue.message).join("; "), /required when output\.format=custom/);
});

test("rejects non-object output.schema values instead of silently widening to {}", async () => {
  const result = await normalizeAndValidateRequest({
    backend: "codex",
    execution_profile: CODEX_PROFILE,
    task: { prompt: "x" },
    workspace: { source_root: os.tmpdir() },
    output: {
      schema: "not-an-object"
    }
  });

  assert.equal(result.ok, false);
  assert.match(result.issues.map((issue) => issue.message).join("; "), /must be an object/);
});

test("rejects removed write_scope and validates tool_configuration shapes", async () => {
  const result = await normalizeAndValidateRequest({
    backend: "codex",
    execution_profile: CODEX_PROFILE,
    task: { prompt: "x" },
    workspace: {
      source_root: os.tmpdir(),
      write_scope: {
        mode: "allowlist",
        enforcement: "strict",
        paths: ["", "../escape"]
      }
    },
    tool_configuration: {
      builtin_policy: {
        mode: "allowlist",
        tools: ["ok-tool", ""]
      },
      mcp_servers: [
        {
          name: "",
          transport: "stdio",
          require_approval: "sometimes"
        },
        {
          name: "events",
          transport: "sse"
        }
      ]
    },
    output: { schema: { type: "object" } }
  });

  assert.equal(result.ok, false);
  const message = result.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ");
  assert.match(message, /\$\.workspace\.write_scope .*removed/);
  assert.match(message, /\$\.tool_configuration\.builtin_policy\.tools\[1\]/);
  assert.match(message, /\$\.tool_configuration\.mcp_servers\[0\]\.name/);
  assert.match(message, /\$\.tool_configuration\.mcp_servers\[0\]\.command/);
  assert.match(message, /\$\.tool_configuration\.mcp_servers\[0\]\.require_approval/);
  assert.match(message, /\$\.tool_configuration\.mcp_servers\[1\]\.url/);
});

test("rejects invalid SSE MCP server URLs", async () => {
  const result = await normalizeAndValidateRequest({
    backend: "codex",
    execution_profile: CODEX_PROFILE,
    task: { prompt: "x" },
    tool_configuration: {
      mcp_servers: [
        {
          name: "events",
          transport: "sse",
          url: "not a url"
        }
      ]
    },
    output: { schema: { type: "object" } }
  });

  assert.equal(result.ok, false);
  assert.match(result.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "), /\$\.tool_configuration\.mcp_servers\[0\]\.url .*valid URL/);
});

test("validation does not mutate normalized attachment paths in place", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "bo-staff-validation-no-mutate-"));
  const attachmentPath = path.join(workspaceRoot, "note.txt");
  await writeFile(attachmentPath, "ok", "utf8");

  try {
    const first = await normalizeAndValidateRequest({
      backend: "codex",
      execution_profile: CODEX_PROFILE,
      task: {
        prompt: "x",
        attachments: [
          {
            name: "note",
            path: "./note.txt"
          }
        ]
      },
      workspace: { source_root: workspaceRoot },
      output: { schema: { type: "object" } }
    });

    const second = await normalizeAndValidateRequest({
      backend: "codex",
      execution_profile: CODEX_PROFILE,
      task: {
        prompt: "x",
        attachments: [
          {
            name: "note",
            path: "./note.txt"
          }
        ]
      },
      workspace: { source_root: workspaceRoot },
      output: { schema: { type: "object" } }
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) {
      throw new Error("expected normalized requests");
    }
    assert.equal(first.value.task.attachments[0]?.kind, "path");
    assert.equal(second.value.task.attachments[0]?.kind, "path");
    if (first.value.task.attachments[0]?.kind !== "path" || second.value.task.attachments[0]?.kind !== "path") {
      throw new Error("expected path attachments");
    }
    assert.equal(first.value.task.attachments[0].path, attachmentPath);
    assert.equal(second.value.task.attachments[0].path, attachmentPath);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Lease validation
// ---------------------------------------------------------------------------

test("lease.allowed_tools accepts valid bomcp tool names", async () => {
  const result = await normalizeAndValidateRequest({
    backend: "codex",
    execution_profile: CODEX_PROFILE,
    task: { prompt: "x" },
    lease: {
      allowed_tools: ["bomcp.control.handoff", "bomcp.progress.update"],
      timeout_seconds: 300
    }
  });
  assert.equal(result.ok, true);
});

test("lease.allowed_tools rejects invalid tool names", async () => {
  const result = await normalizeAndValidateRequest({
    backend: "codex",
    execution_profile: CODEX_PROFILE,
    task: { prompt: "x" },
    lease: {
      allowed_tools: ["bomcp.control.handoff", "not_a_valid_tool"]
    }
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.message.includes("valid bomcp tool name")));
  }
});

test("lease.timeout_seconds rejects non-positive values", async () => {
  const result = await normalizeAndValidateRequest({
    backend: "codex",
    execution_profile: CODEX_PROFILE,
    task: { prompt: "x" },
    lease: { timeout_seconds: -5 }
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.path.includes("lease.timeout_seconds")));
  }
});

test("bomcp MCP server name is reserved", async () => {
  const result = await normalizeAndValidateRequest({
    backend: "codex",
    execution_profile: CODEX_PROFILE,
    task: { prompt: "x" },
    tool_configuration: {
      mcp_servers: [{
        name: "bomcp",
        transport: "stdio",
        command: "fake"
      }]
    }
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.message.includes("reserved")));
  }
});
