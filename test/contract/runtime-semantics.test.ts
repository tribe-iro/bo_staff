import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { ExecutionAdmissionController } from "../../src/engine/execution-admission.ts";
import { runCommand } from "../../src/adapters/process.ts";
import { acquireDataDirLock } from "../../src/persistence/data-dir-lock.ts";
import { ExecutionManager } from "../../src/engine/execution-manager.ts";
import { BoStaff } from "../../src/gateway.ts";
import { loadExecutionProfiles } from "../../src/config/execution-profiles.ts";
import { WorkerThreadSqliteBoStaffRepository } from "../../src/persistence/sqlite-worker-repository.ts";
import type { BoStaffRepository } from "../../src/persistence/types.ts";
import { normalizeAndValidateRequest } from "../../src/validation.ts";
import { createTestGateway, FakeAdapter } from "./fixtures.ts";

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
      task: { prompt: "x" },
      session: { mode: "ephemeral" },
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

test("ephemeral executions do not expose or persist resumable session handles", async () => {
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
    }, "req_ephemeral_no_persist");

    assert.equal(result.httpStatus, 200);
    assert.equal(result.body.session.handle, null);

    assert.deepEqual((await harness.repository.listSessionsPage({ limit: 10 })).sessions, []);
  } finally {
    await harness.cleanup();
  }
});

test("continue rejects legacy ephemeral session handles", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "bo-staff-legacy-ephemeral-"));
  const repository: BoStaffRepository = {
    async getSession(handle) {
      return handle === "sess_legacy_ephemeral"
        ? {
          handle,
          backend: "codex",
          continuity_kind: "none",
          durability_kind: "ephemeral",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          provider_session_id: "provider-legacy",
          workspace_topology: "direct",
          source_root: workspaceRoot
        }
        : undefined;
    },
    async listSessionsPage() {
      return { sessions: [] };
    },
    async countSessions() {
      return 0;
    },
    async getExecution() {
      return undefined;
    },
    async getExecutionEvents() {
      return [];
    },
    async getExecutionEventsPage() {
      return { events: [] };
    },
    async pruneSessionlessTerminalExecutions() {
      return 0;
    },
    async deleteSession() {
      return false;
    },
    async recoverInterruptedExecutions() {},
    async initializeExecution() {
      throw new Error("should not initialize");
    },
    async appendExecutionEvent() {
      return 1;
    },
    async commitTerminalExecution() {},
    async close() {}
  };
  const gateway = new BoStaff({
    dataDir: workspaceRoot,
    repository,
    executionManager: new ExecutionManager({
      adapters: [
        new FakeAdapter("codex", async () => {
          throw new Error("should not execute");
        })
      ],
      repository,
      dataDir: workspaceRoot
    })
  });

  try {
    const result = await gateway.execute({
      backend: "codex",
      task: { prompt: "x" },
      session: {
        mode: "continue",
        handle: "sess_legacy_ephemeral"
      },
      workspace: {
        source_root: workspaceRoot
      },
      output: {
        schema: {
          type: "object"
        }
      }
    }, "req_legacy_ephemeral");

    assert.equal(result.httpStatus, 400);
    assert.equal(result.body.execution.status, "rejected");
    assert.equal(result.body.execution.progress_state, "finished");
    assert.equal(result.body.persistence.status, "persisted");
    assert.match(result.body.errors[0]?.message ?? "", /Ephemeral session handles cannot be continued or forked/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("successful executions preserve runtime status when terminal persistence fails", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "bo-staff-persist-failure-"));
  const repository: BoStaffRepository = {
    async getSession() {
      return undefined;
    },
    async listSessionsPage() {
      return { sessions: [] };
    },
    async countSessions() {
      return 0;
    },
    async getExecution() {
      return undefined;
    },
    async getExecutionEvents() {
      return [];
    },
    async getExecutionEventsPage() {
      return { events: [] };
    },
    async pruneSessionlessTerminalExecutions() {
      return 0;
    },
    async deleteSession() {
      return false;
    },
    async recoverInterruptedExecutions() {},
    async initializeExecution() {},
    async appendExecutionEvent() {
      return 1;
    },
    async commitTerminalExecution() {
      throw new Error("disk full");
    },
    async close() {}
  };
  const gateway = new BoStaff({
    dataDir: workspaceRoot,
    repository,
    executionManager: new ExecutionManager({
      adapters: [
        new FakeAdapter("codex", () => ({
          compact_output: {
            summary: "done",
            payload: { content: "ok" },
            pending_items: [],
            artifacts: []
          }
        }))
      ],
      repository,
      dataDir: workspaceRoot
    })
  });

  try {
    const result = await gateway.execute({
      backend: "codex",
      task: { prompt: "x" },
      session: { mode: "ephemeral" },
      workspace: { source_root: workspaceRoot },
      output: { schema: MESSAGE_SCHEMA }
    }, "req_persist_failure_completed");

    assert.equal(result.httpStatus, 500);
    assert.equal(result.body.execution.status, "completed");
    assert.equal(result.body.execution.progress_state, "finished");
    assert.equal(result.body.persistence.status, "failed");
    assert.match(result.body.persistence.reason ?? "", /disk full/);
    assert.deepEqual(result.body.result.payload, { content: "ok" });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("unexpected runtime failures still report finished progress state", async () => {
  const harness = await createTestGateway({
    adapters: [
      new FakeAdapter("codex", async () => {
        throw new Error("adapter crashed");
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
      output: { schema: MESSAGE_SCHEMA }
    }, "req_runtime_failure_progress");

    assert.equal(result.httpStatus, 500);
    assert.equal(result.body.execution.status, "failed");
    assert.equal(result.body.execution.progress_state, "finished");
    assert.equal(result.body.persistence.status, "persisted");
    assert.match(result.body.errors[0]?.message ?? "", /adapter crashed/);
  } finally {
    await harness.cleanup();
  }
});

test("git_isolated writeback cannot materialize changes outside a repo-subdirectory source_root", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "bo-staff-subdir-repo-"));
  const sourceRoot = path.join(repoRoot, "subdir");
  const outsidePath = path.join(repoRoot, "outside.txt");
  try {
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(path.join(sourceRoot, "inside.txt"), "inside-before\n", "utf8");
    await writeFile(outsidePath, "outside-before\n", "utf8");
    await initGitRepo(repoRoot);

    const harness = await createTestGateway({
      adapters: [
        new FakeAdapter("codex", async ({ workspace }) => {
          await writeFile(path.join(workspace.runtime_working_directory, "..", "outside.txt"), "outside-after\n", "utf8");
          return {
            compact_output: {
              summary: "done",
              payload: { content: "ok" },
              pending_items: [],
              artifacts: []
            }
          };
        })
      ]
    });

    try {
      const result = await harness.gateway.execute({
        backend: "codex",
        task: { prompt: "x" },
        session: { mode: "ephemeral" },
        workspace: {
          source_root: sourceRoot,
          writeback: "apply"
        },
        policy: {
          isolation: "require_workspace_isolation",
          filesystem: "workspace_write"
        },
        output: { schema: MESSAGE_SCHEMA }
      }, "req_subdir_authority");

      assert.equal(result.httpStatus, 200);
      assert.equal(result.body.workspace.writeback_status, "degraded");
      assert.equal(result.body.workspace.materialization_status, "failed");
      assert.equal(result.body.workspace.diagnostics?.skipped_entry_count, 1);
      assert.equal(result.body.workspace.diagnostics?.skipped_entries?.[0]?.repo_relative_path, "outside.txt");
      assert.equal(result.body.execution.degraded, true);
      assert.equal(await readFile(outsidePath, "utf8"), "outside-before\n");
    } finally {
      await harness.cleanup();
    }
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("repository persists execution events incrementally", async () => {
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
    await harness.gateway.execute({
      backend: "codex",
      task: { prompt: "x" },
      session: { mode: "new" },
      workspace: { source_root: workspaceRoot },
      output: { schema: MESSAGE_SCHEMA }
    }, "req_events");

    const session = (await harness.repository.listSessionsPage({ limit: 10 })).sessions[0];
    assert.ok(session?.latest_execution_id);
    const events = await harness.repository.getExecutionEvents(session.latest_execution_id!);
    assert.ok(events.length >= 4);
    assert.deepEqual(events.map((entry) => entry.event), [
      "execution.accepted",
      "execution.started",
      "execution.progress_initialized",
      "execution.progressed",
      "execution.progressed",
      "execution.completed",
      "execution.snapshot"
    ]);
  } finally {
    await harness.cleanup();
  }
});

test("worker-thread sqlite repository closes cleanly and idempotently", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "bo-staff-worker-close-"));
  const repository = new WorkerThreadSqliteBoStaffRepository(dataDir);
  try {
    assert.equal(await repository.countSessions(), 0);
    await repository.close();
    await repository.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("data-dir lock reclaims stale lock files from dead processes", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "bo-staff-lock-stale-"));
  try {
    await writeFile(path.join(dataDir, ".bo-staff.lock"), JSON.stringify({
      pid: 999_999_999,
      acquired_at: new Date().toISOString()
    }), "utf8");

    const lock = await acquireDataDirLock(dataDir);
    await lock.release();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
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

test("execution profile cache remains bounded across distinct file paths", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bo-staff-profiles-cache-"));
  const yaml = [
    "version: v1",
    "providers:",
    "  codex:",
    "    managed:",
    "      performance_tiers:",
    "        fast: gpt-5-mini",
    "        balanced: gpt-5",
    "        high: gpt-5",
    "        frontier: gpt-5-pro",
    "      reasoning_tiers:",
    "        none: {}",
    "        light: {}",
    "        standard: {}",
    "        deep: {}",
    "  claude:",
    "    managed:",
    "      performance_tiers:",
    "        fast: claude-haiku",
    "        balanced: claude-sonnet",
    "        high: claude-sonnet",
    "        frontier: claude-opus",
    "      reasoning_tiers:",
    "        none: {}",
    "        light: {}",
    "        standard: {}",
    "        deep: {}",
    ""
  ].join("\n");
  try {
    for (let index = 0; index < 8; index += 1) {
      const filePath = path.join(tempDir, `profiles-${index}.yaml`);
      await writeFile(filePath, yaml, "utf8");
      const loaded = await loadExecutionProfiles(filePath);
      assert.equal(loaded.version, "v1");
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("workspace cleanup removes transient run directories after completion", async () => {
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
    await harness.gateway.execute({
      backend: "codex",
      task: { prompt: "x" },
      session: { mode: "new" },
      workspace: { source_root: workspaceRoot },
      output: { schema: MESSAGE_SCHEMA }
    }, "req_cleanup_runs");

    const runsRoot = path.join(harness.dataDir, "runs");
    const runHandles = await readdir(runsRoot);
    assert.deepEqual(runHandles, []);
  } finally {
    await harness.cleanup();
  }
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
