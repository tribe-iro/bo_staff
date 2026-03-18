import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { runCommand } from "../../src/adapters/process.ts";
import { parseCompactOutput } from "../../src/compat/policies.ts";
import { buildExecutionPrompt } from "../../src/engine/prompt.ts";
import { UpstreamRuntimeError } from "../../src/errors.ts";
import { extractSingleEmbeddedFencedJsonObjectText } from "../../src/json/extract.ts";
import { normalizeAndValidateRequest } from "../../src/validation.ts";

test("prompt builder places task objective before task prompt and supporting context after", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "bo-staff-prompt-"));
  try {
    const normalized = await normalizeAndValidateRequest({
      backend: "codex",
      task: {
        objective: "Optimize for correctness before speed.",
        prompt: "Implement the requested change.",
        context: {
          module: "prompt-builder"
        },
        constraints: ["Return valid JSON."]
      },
      session: {
        mode: "ephemeral"
      },
      workspace: {
        source_root: workspaceRoot
      },
      output: {
        format: "message",
        schema: {
          type: "object",
          properties: {
            content: { type: "string" }
          },
          required: ["content"],
          additionalProperties: false
        }
      }
    });

    if (!normalized.ok) {
      assert.fail(`request failed validation: ${normalized.issues.map((issue) => issue.message).join("; ")}`);
    }

    const prompt = await buildExecutionPrompt({ request: normalized.value });
    const sections = prompt.split("\n\n");

    const objectiveIndex = sections.findIndex((section) =>
      section.startsWith("Task objective:\nOptimize for correctness before speed.")
    );
    const promptIndex = sections.findIndex((section) =>
      section.startsWith("Task prompt:\nImplement the requested change.")
    );
    const contextIndex = sections.findIndex((section) =>
      section.startsWith("Task context JSON:\n")
    );
    const constraintsIndex = sections.findIndex((section) =>
      section.startsWith("Task constraints:\n")
    );

    assert.notEqual(objectiveIndex, -1);
    assert.notEqual(promptIndex, -1);
    assert.notEqual(contextIndex, -1);
    assert.notEqual(constraintsIndex, -1);
    assert.ok(objectiveIndex < promptIndex);
    assert.ok(promptIndex < contextIndex);
    assert.ok(contextIndex < constraintsIndex);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runCommand rejects when stderr exceeds the configured byte limit", async () => {
  await assert.rejects(
    runCommand({
      command: "sh",
      args: ["-c", "head -c 2048 /dev/zero >&2"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      maxOutputBytes: 1024
    }),
    (error: unknown) => {
      assert.ok(error instanceof UpstreamRuntimeError);
      assert.match(error.message, /stderr exceeded 1024 bytes/);
      return true;
    }
  );
});

test("compact output parsing accepts plain text for the default message schema only", () => {
  const valid = parseCompactOutput({
    raw_text: JSON.stringify({
      summary: "ok",
      payload: { content: "hello" },
      pending_items: [],
      artifacts: []
    }),
    payload_schema: {
      type: "object",
      required: ["content"],
      additionalProperties: false,
      properties: {
        content: { type: "string" }
      }
    }
  });
  assert.equal(valid.status, "valid");
  assert.deepEqual(valid.value?.payload, { content: "hello" });

  const messageFallback = parseCompactOutput({
    raw_text: "hello",
    payload_schema: {
      type: "object",
      required: ["content"],
      additionalProperties: false,
      properties: {
        content: { type: "string" }
      }
    }
  });
  assert.equal(messageFallback.status, "valid");
  assert.deepEqual(messageFallback.value?.payload, { content: "hello" });

  const invalid = parseCompactOutput({
    raw_text: "hello",
    payload_schema: {
      type: "object",
      required: ["status"],
      additionalProperties: false,
      properties: {
        status: { type: "string" }
      }
    }
  });
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.value, undefined);
});

test("compact output parsing rejects multi-fenced output instead of coercing it into a message payload", () => {
  const parsed = parseCompactOutput({
    raw_text: [
      "```json",
      "{\"summary\":\"a\"}",
      "```",
      "",
      "```json",
      "{\"summary\":\"b\"}",
      "```"
    ].join("\n"),
    payload_schema: {
      type: "object",
      required: ["content"],
      additionalProperties: false,
      properties: {
        content: { type: "string" }
      }
    }
  });

  assert.equal(parsed.status, "invalid");
  assert.equal(parsed.value, undefined);
});

test("embedded fenced JSON extraction only accepts a single object block", () => {
  assert.equal(
    extractSingleEmbeddedFencedJsonObjectText(
      "discard-ok\n\n```json\n{\"summary\":\"ok\",\"payload\":{\"content\":\"discard-ok\"},\"pending_items\":[]}\n```"
    ),
    "{\"summary\":\"ok\",\"payload\":{\"content\":\"discard-ok\"},\"pending_items\":[]}"
  );
  assert.equal(
    extractSingleEmbeddedFencedJsonObjectText(
      "```json\n{\"summary\":\"a\"}\n```\n\n```json\n{\"summary\":\"b\"}\n```"
    ),
    undefined
  );
});

test("prompt builder renders managed continuation as a framework-owned capsule", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "bo-staff-prompt-managed-"));
  try {
    const normalized = await normalizeAndValidateRequest({
      backend: "codex",
      task: {
        prompt: "Continue the task."
      },
      session: {
        mode: "ephemeral"
      },
      workspace: {
        source_root: workspaceRoot
      },
      output: {
        format: "message",
        schema: {
          type: "object",
          properties: {
            content: { type: "string" }
          },
          required: ["content"],
          additionalProperties: false
        }
      }
    });

    if (!normalized.ok) {
      assert.fail(`request failed validation: ${normalized.issues.map((issue) => issue.message).join("; ")}`);
    }

    const prompt = await buildExecutionPrompt({
      request: normalized.value,
      managedContext: {
        schema_version: 1,
        prior_execution_id: "exec_prev",
        backend_origin: "codex",
        result_summary: "Prior model output",
        memory_slots: [
          { key: "remembered_token", value: "tok-123" }
        ],
        total_bytes: 32
      }
    });

  assert.match(prompt, /framework-captured memory from a prior bo_staff execution/);
    assert.match(prompt, /MANAGED CONTINUATION CAPSULE BEGIN/);
    assert.match(prompt, /remembered_token: tok-123/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
