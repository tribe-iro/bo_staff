import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { ExecutionAdmissionController } from "../../src/engine/execution-admission.ts";
import { runCommand } from "../../src/adapters/process.ts";
import { normalizeAndValidateRequest } from "../../src/validation.ts";
import { createTestGateway, FakeAdapter } from "./fixtures.ts";

const CODEX_PROFILE = { model: "gpt-5" } as const;
const MESSAGE_SCHEMA = {
  type: "object",
  required: ["content"],
  additionalProperties: false,
  properties: {
    content: { type: "string" }
  }
} as const;

test("rejects workspace.scope.subpath that escapes workspace.source_root", async () => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "bo-staff-scope-root-"));
  const escapedRoot = await mkdtemp(path.join(os.tmpdir(), "bo-staff-scope-escape-"));
  try {
    const result = await normalizeAndValidateRequest({
      backend: "codex",
      execution_profile: CODEX_PROFILE,
      task: { prompt: "x" },
      workspace: {
        source_root: sourceRoot,
        scope: {
          mode: "subpath",
          subpath: path.relative(sourceRoot, escapedRoot)
        }
      },
      output: {
        schema: {
          type: "object"
        }
      }
    });

    assert.equal(result.ok, false);
    assert.match(result.issues.map((issue) => issue.message).join("; "), /within workspace\.source_root/);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(escapedRoot, { recursive: true, force: true });
  }
});

test("execution admission controller can resume after a completed drain", async () => {
  const admission = new ExecutionAdmissionController(1);
  assert.equal(admission.tryAcquire(), true);
  const drain = admission.drain();
  assert.equal(admission.isDraining(), true);
  assert.equal(admission.tryAcquire(), false);
  admission.release();
  await drain;
  admission.resume();
  assert.equal(admission.isDraining(), false);
  assert.equal(admission.tryAcquire(), true);
  admission.release();
});

test("runCommand accepts stdin text for prompt transport", async () => {
  const result = await runCommand({
    command: "sh",
    args: ["-c", "cat"],
    cwd: process.cwd(),
    timeoutMs: 5_000,
    stdinText: "hello from stdin"
  });

  assert.equal(result.stdout, "hello from stdin");
});

async function initGitRepo(root: string): Promise<void> {
  await runCommand({
    command: "git",
    args: ["init"],
    cwd: root,
    timeoutMs: 10_000
  });
  await runCommand({
    command: "git",
    args: ["config", "user.email", "test@example.com"],
    cwd: root,
    timeoutMs: 10_000
  });
  await runCommand({
    command: "git",
    args: ["config", "user.name", "bo_staff tests"],
    cwd: root,
    timeoutMs: 10_000
  });
  await runCommand({
    command: "git",
    args: ["add", "."],
    cwd: root,
    timeoutMs: 10_000
  });
  await runCommand({
    command: "git",
    args: ["commit", "-m", "init"],
    cwd: root,
    timeoutMs: 10_000
  });
}
