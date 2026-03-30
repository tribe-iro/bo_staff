import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { runCommand } from "../../src/adapters/process.ts";
import { ClaudeEventParser } from "../../src/adapters/claude/parser.ts";
import { CodexEventParser } from "../../src/adapters/codex/parser.ts";
import {
  canonicalizeProviderResultText,
  executeCliAdapter,
  extractStructuredProviderResultText,
  normalizeProviderResultText
} from "../../src/adapters/shared.ts";
import { parseCompactOutput } from "../../src/bomcp/output.ts";
import { buildExecutionPrompt } from "../../src/engine/prompt.ts";
import { UpstreamRuntimeError } from "../../src/errors.ts";
import { extractSingleEmbeddedFencedJsonObjectText } from "../../src/json/extract.ts";
import { normalizeAndValidateRequest } from "../../src/validation.ts";

const CODEX_PROFILE = { model: "gpt-5" } as const;

function flattenPrompt(input: {
  system: { sections: Array<{ content: string }> };
  user: { sections: Array<{ content: string }> };
}): string {
  return [...input.system.sections, ...input.user.sections].map((section) => section.content).join("\n\n");
}

test("prompt builder places task objective before task prompt and supporting context after", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "bo-staff-prompt-"));
  try {
    const normalized = await normalizeAndValidateRequest({
      backend: "codex",
      execution_profile: CODEX_PROFILE,
      task: {
        objective: "Optimize for correctness before speed.",
        prompt: "Implement the requested change.",
        context: {
          module: "prompt-builder"
        },
        constraints: ["Return valid JSON."]
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
    const sections = [...prompt.user.sections, ...prompt.system.sections].map((section) => section.content);

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

test("executeCliAdapter preserves terminal failure diagnostics instead of throwing away provider output", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "bo-staff-cli-failure-"));
  try {
    const normalized = await normalizeAndValidateRequest({
      backend: "codex",
      execution_profile: CODEX_PROFILE,
      task: {
        prompt: "ignored"
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

    const events = [];
    for await (const event of executeCliAdapter({
      context: {
        request_id: "req_cli_failure",
        execution_id: "exec_cli_failure",
        signal: new AbortController().signal,
        request: normalized.value,
        execution_profile: {
          model: "gpt-5",
          reasoning_effort: undefined
        },
        workspace: {
          topology: "direct",
          source_root: workspaceRoot,
          runtime_working_directory: workspaceRoot,
          run_dir: workspaceRoot,
          scope_status: "unbounded"
        },
        prompt: {
          system: { sections: [] },
          user: {
            sections: [{ label: "task_prompt", content: "Task prompt:\nignored" }],
            attachments: []
          }
        }
      },
      command: "sh",
      args: ["-c", "printf 'stdout-line\\n'; printf 'stderr-line\\n' >&2; exit 7"],
      rendered_prompt: {
        stdin_text: "ignored"
      },
      parser: {
        onStdoutChunk: () => [],
        onStderrChunk: () => [],
        finish: () => {
          assert.fail("finish should not run on provider terminal failure");
        }
      }
    })) {
      events.push(event);
    }

    const failure = events.at(-1);
    assert.deepEqual(events.map((event) => event.type), ["provider.started", "provider.output.chunk", "provider.failed"]);
    assert.equal(failure?.type, "provider.failed");
    assert.match(failure?.error.message ?? "", /exited with code 7/);
    assert.match(failure?.error.message ?? "", /stderr-line/);
    assert.equal(failure?.error.debug?.termination_reason, "exited");
    assert.equal(failure?.error.debug?.exit_code, 7);
    assert.match(String(failure?.error.debug?.stderr_tail ?? ""), /stderr-line/);
    assert.match(String(failure?.error.debug?.stdout_tail ?? ""), /stdout-line/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("executeCliAdapter prefers meaningful structured failure output over boilerplate stderr", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "bo-staff-cli-structured-failure-"));
  try {
    const normalized = await normalizeAndValidateRequest({
      backend: "codex",
      execution_profile: CODEX_PROFILE,
      task: {
        prompt: "ignored"
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

    const events = [];
    for await (const event of executeCliAdapter({
      context: {
        request_id: "req_cli_structured_failure",
        execution_id: "exec_cli_structured_failure",
        signal: new AbortController().signal,
        request: normalized.value,
        execution_profile: {
          model: "gpt-5",
          reasoning_effort: undefined
        },
        workspace: {
          topology: "direct",
          source_root: workspaceRoot,
          runtime_working_directory: workspaceRoot,
          run_dir: workspaceRoot,
          scope_status: "unbounded"
        },
        prompt: {
          system: { sections: [] },
          user: {
            sections: [{ label: "task_prompt", content: "Task prompt:\nignored" }],
            attachments: []
          }
        }
      },
      command: "sh",
      args: [
        "-c",
        "printf 'Reading prompt from stdin...\\n' >&2; printf '{\"type\":\"error\",\"message\":\"upstream disconnected before completion\"}\\n'; exit 1"
      ],
      rendered_prompt: {
        stdin_text: "ignored"
      },
      parser: {
        onStdoutChunk: () => [],
        onStderrChunk: () => [],
        finish: () => {
          assert.fail("finish should not run on provider terminal failure");
        }
      }
    })) {
      events.push(event);
    }

    const failure = events.at(-1);
    assert.equal(failure?.type, "provider.failed");
    assert.match(failure?.error.message ?? "", /upstream disconnected before completion/);
    assert.doesNotMatch(failure?.error.message ?? "", /Reading prompt from stdin/);
    assert.equal(failure?.error.debug?.output_excerpt, "upstream disconnected before completion");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("shared provider result extraction preserves structured output objects", () => {
  assert.equal(
    extractStructuredProviderResultText({
      structured_output: {
        outcome: "success",
        summary: "ok",
        artifacts: [],
        actions: [],
        verification_notes: [],
        open_issues: []
      },
      raw_result: ""
    }),
    JSON.stringify({
      outcome: "success",
      summary: "ok",
      artifacts: [],
      actions: [],
      verification_notes: [],
      open_issues: []
    })
  );
});

test("shared provider result canonicalization wraps direct custom payload objects into compact output", () => {
  const canonical = canonicalizeProviderResultText({
    context: {
      request: {
        output: {
          format: "custom",
          schema: {
            type: "object",
            properties: {
              outcome: { type: "string" }
            }
          }
        }
      } as never
    } as never,
    raw_text: JSON.stringify({
      outcome: "success",
      summary: "ok",
      artifacts: [],
      actions: [],
      verification_notes: [],
      open_issues: []
    })
  });

  const parsed = parseCompactOutput({ raw_text: canonical });
  assert.equal(parsed.status, "valid");
  assert.deepEqual(parsed.value?.payload, {
    outcome: "success",
    summary: "ok",
    artifacts: [],
    actions: [],
    verification_notes: [],
    open_issues: []
  });
});

test("claude parser preserves structured custom output objects instead of dropping them", () => {
  const parser = new ClaudeEventParser();
  const summary = parser.finish({
    context: {
      request_id: "req_claude_structured",
      execution_id: "exec_claude_structured",
      signal: new AbortController().signal,
      request: {
        output: {
          format: "custom"
        },
        tool_configuration: undefined
      } as never,
      execution_profile: {
        model: "claude-haiku-4-5",
        reasoning_effort: undefined
      },
      workspace: {
        topology: "direct",
        source_root: process.cwd(),
        runtime_working_directory: process.cwd(),
        run_dir: process.cwd(),
        scope_status: "unbounded"
      },
      prompt: {
        system: { sections: [] },
        user: { sections: [], attachments: [] }
      }
    },
    stdout: JSON.stringify({
      type: "result",
      result: "",
      structured_output: {
        outcome: "success",
        summary: "ok",
        artifacts: [],
        actions: [],
        verification_notes: [],
        open_issues: []
      }
    }),
    stderr: ""
  });

  const parsed = parseCompactOutput({
    raw_text: summary.raw_output_text ?? ""
  });
  assert.equal(parsed.status, "valid");
  assert.deepEqual(parsed.value?.payload, {
    outcome: "success",
    summary: "ok",
    artifacts: [],
    actions: [],
    verification_notes: [],
    open_issues: []
  });
});

test("compact output parsing requires valid bo_staff compact JSON", () => {
  const valid = parseCompactOutput({
    raw_text: JSON.stringify({
      summary: "ok",
      payload: { content: "hello" },
      pending_items: [],
      artifacts: []
    })
  });
  assert.equal(valid.status, "valid");
  assert.deepEqual(valid.value?.payload, { content: "hello" });

  const invalid = parseCompactOutput({
    raw_text: "hello"
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
    ].join("\n")
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

test("shared provider result normalization strips a single fenced compact JSON block", () => {
  const normalized = normalizeProviderResultText([
    "```json",
    "{\"summary\":\"ok\",\"payload\":{\"content\":\"hello\"},\"pending_items\":[],\"artifacts\":[]}",
    "```"
  ].join("\n"));

  assert.equal(
    normalized,
    "{\"summary\":\"ok\",\"payload\":{\"content\":\"hello\"},\"pending_items\":[],\"artifacts\":[]}"
  );
});
