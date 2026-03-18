import path from "node:path";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { runCommand } from "../../adapters/process.ts";
import { ensureDir, removeDir } from "../../utils.ts";

const worktreeLocks = new Map<string, Promise<void>>();

export function worktreeRoot(dataDir: string): string {
  return path.join(dataDir, "worktrees");
}

export function worktreePath(dataDir: string, retainedWorkspaceHandle: string): string {
  return path.join(worktreeRoot(dataDir), retainedWorkspaceHandle);
}

export async function ensureDetachedWorktree(input: {
  dataDir: string;
  repoRoot: string;
  sourceCommit: string;
  retainedWorkspaceHandle: string;
}): Promise<string> {
  const target = worktreePath(input.dataDir, input.retainedWorkspaceHandle);
  return withWorktreeLock(target, async () => {
    try {
      await access(target, constants.R_OK);
      return target;
    } catch {
      // create below
    }
    await ensureDir(worktreeRoot(input.dataDir));
    const result = await runCommand({
      command: "git",
      args: ["worktree", "add", "--detach", target, input.sourceCommit],
      cwd: input.repoRoot,
      timeoutMs: 60_000
    });
    if (result.exitCode !== 0) {
      throw new Error(`git worktree add failed: ${result.stderr || result.stdout}`);
    }
    return target;
  });
}

export async function removeDetachedWorktree(input: {
  repoRoot: string;
  worktreeDir: string;
}): Promise<void> {
  await withWorktreeLock(input.worktreeDir, async () => {
    try {
      await access(input.worktreeDir, constants.R_OK);
    } catch {
      return;
    }
    const result = await runCommand({
      command: "git",
      args: ["worktree", "remove", "--force", input.worktreeDir],
      cwd: input.repoRoot,
      timeoutMs: 60_000
    });
    if (result.exitCode === 0) {
      return;
    }
    try {
      await access(input.worktreeDir, constants.R_OK);
    } catch {
      return;
    }
    await removeDir(input.worktreeDir);
  });
}

async function withWorktreeLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = worktreeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  worktreeLocks.set(key, queued);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    const active = worktreeLocks.get(key);
    if (active === queued) {
      worktreeLocks.delete(key);
    }
  }
}
