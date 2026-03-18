import path from "node:path";
import { runCommand } from "../../adapters/process.ts";
import { normalizeAbsolutePath } from "../../utils.ts";

export interface GitRepositoryContext {
  repo_root: string;
  workspace_subpath: string;
}

export async function resolveGitRepositoryContext(workingDirectory: string): Promise<GitRepositoryContext | undefined> {
  const normalized = normalizeAbsolutePath(workingDirectory);
  let result;
  try {
    result = await runCommand({
      command: "git",
      args: ["rev-parse", "--show-toplevel"],
      cwd: normalized,
      timeoutMs: 10_000
    });
  } catch {
    return undefined;
  }
  if (result.exitCode !== 0) {
    return undefined;
  }
  const repoRoot = normalizeAbsolutePath(result.stdout.trim());
  const workspaceSubpath = path.relative(repoRoot, normalized) || ".";
  if (workspaceSubpath.startsWith("..") || path.isAbsolute(workspaceSubpath)) {
    return undefined;
  }
  return {
    repo_root: repoRoot,
    workspace_subpath: workspaceSubpath
  };
}

export async function resolveHeadCommit(repoRoot: string): Promise<string> {
  const result = await runCommand({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: repoRoot,
    timeoutMs: 10_000
  });
  if (result.exitCode !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}
