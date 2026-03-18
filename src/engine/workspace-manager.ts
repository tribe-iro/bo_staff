import path from "node:path";
import { mkdir, rmdir } from "node:fs/promises";
import { collectGitMaterializationPlan } from "../workspace/git/status.ts";
import { applyMaterializationPlan } from "../workspace/git/apply.ts";
import { resolveGitRepositoryContext, resolveHeadCommit } from "../workspace/git/resolve-repo.ts";
import { ensureDetachedWorktree, removeDetachedWorktree } from "../workspace/git/worktree.ts";
import { RequestResolutionError } from "../errors.ts";
import { resolveWorkspaceScopeRoot, toRepoRelativeScopeRoot } from "../workspace/scope.ts";
import type {
  NormalizedExecutionRequest,
  WorkspaceDiagnostics,
  WorkspaceMaterializationStatus,
  WorkspaceScopeStatus,
  WorkspaceWritebackStatus
} from "../types.ts";
import { generateHandle, nowIso, removeDir } from "../utils.ts";

const MAX_SKIPPED_ENTRY_DIAGNOSTICS = 25;

interface WorkspaceRuntimeBase {
  topology: "direct" | "git_isolated";
  source_root: string | null;
  runtime_working_directory: string;
  run_dir: string;
  scope_status: WorkspaceScopeStatus;
  writeback_status: WorkspaceWritebackStatus;
  materialization_status: WorkspaceMaterializationStatus;
  diagnostics?: WorkspaceDiagnostics;
}

export interface DirectWorkspaceRuntime extends WorkspaceRuntimeBase {
  topology: "direct";
}

export interface GitIsolatedWorkspaceRuntime extends WorkspaceRuntimeBase {
  topology: "git_isolated";
  source_root: string;
  retained_workspace_handle: string;
  repo_root: string;
  worktree_dir: string;
  source_commit: string;
  repo_relative_authority_root: string;
}

export type WorkspaceRuntime = DirectWorkspaceRuntime | GitIsolatedWorkspaceRuntime;

export class WorkspaceManager {
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async prepare(input: {
    request: NormalizedExecutionRequest;
    runtimeHandle: string;
  }): Promise<WorkspaceRuntime> {
    const runDir = path.join(
      this.dataDir,
      "runs",
      input.runtimeHandle,
      `${nowIso().replaceAll(":", "-")}-${generateHandle("run").slice(4, 12)}`
    );
    await mkdir(runDir, { recursive: true });
    const authorityRoot = resolveWorkspaceScopeRoot(input.request.workspace);

    if (input.request.workspace.kind === "ephemeral") {
      const runtimeWorkingDirectory = path.join(runDir, "workspace");
      await mkdir(runtimeWorkingDirectory, { recursive: true });
      return {
        topology: "direct",
        source_root: null,
        runtime_working_directory: runtimeWorkingDirectory,
        run_dir: runDir,
        scope_status: "unbounded",
        writeback_status: "not_requested",
        materialization_status: "not_requested"
      };
    }

    if (input.request.workspace.topology === "direct") {
      return {
        topology: "direct",
        source_root: input.request.workspace.source_root,
        runtime_working_directory: authorityRoot,
        run_dir: runDir,
        scope_status: input.request.workspace.scope.mode === "subpath" ? "enforced" : "unbounded",
        writeback_status: "not_requested",
        materialization_status: "not_requested"
      };
    }

    const repoContext = await resolveGitRepositoryContext(authorityRoot);
    if (!repoContext) {
      throw new RequestResolutionError(
        "workspace.topology=git_isolated requires source_root to be inside a git repository"
      );
    }
    const retainedWorkspaceHandle = input.runtimeHandle;
    const sourceCommit = await resolveHeadCommit(repoContext.repo_root);
    const worktreeDir = await ensureDetachedWorktree({
      dataDir: this.dataDir,
      repoRoot: repoContext.repo_root,
      sourceCommit,
      retainedWorkspaceHandle
    });
    const runtimeWorkingDirectory = repoContext.workspace_subpath === "."
      ? worktreeDir
      : path.join(worktreeDir, repoContext.workspace_subpath);

    return {
      topology: "git_isolated",
      source_root: input.request.workspace.source_root,
      runtime_working_directory: runtimeWorkingDirectory,
      run_dir: runDir,
      scope_status: "enforced",
      writeback_status: input.request.workspace.writeback === "apply" ? "not_requested" : "discarded",
      materialization_status: "not_requested",
      retained_workspace_handle: retainedWorkspaceHandle,
      repo_root: repoContext.repo_root,
      worktree_dir: worktreeDir,
      source_commit: sourceCommit,
      repo_relative_authority_root: toRepoRelativeScopeRoot(repoContext.repo_root, authorityRoot)
    };
  }

  async materialize(input: {
    request: NormalizedExecutionRequest;
    runtime: WorkspaceRuntime;
  }): Promise<WorkspaceRuntime> {
    if (input.runtime.topology !== "git_isolated" || input.request.workspace.writeback !== "apply") {
      return input.runtime;
    }
    const plan = await collectGitMaterializationPlan({
      repoRoot: input.runtime.repo_root,
      worktreeDir: input.runtime.worktree_dir,
      allowedRepoRelativeRoot: input.runtime.repo_relative_authority_root,
      sourceCommit: input.runtime.source_commit
    });
    const errors = await applyMaterializationPlan({
      repoRoot: input.runtime.repo_root,
      worktreeDir: input.runtime.worktree_dir,
      allowedRepoRelativeRoot: input.runtime.repo_relative_authority_root,
      entries: plan.entries
    });
    const degraded = errors.length > 0 || plan.skipped_entries.length > 0;
    return {
      ...input.runtime,
      writeback_status: degraded ? "degraded" : "applied",
      materialization_status: degraded ? "failed" : "materialized",
      diagnostics: degraded
        ? buildWorkspaceDiagnostics({
          skippedEntries: plan.skipped_entries,
          errors
        })
        : undefined
    };
  }

  async cleanup(runtime: WorkspaceRuntime): Promise<void> {
    try {
      if (runtime.topology === "git_isolated") {
        await removeDetachedWorktree({
          repoRoot: runtime.repo_root,
          worktreeDir: runtime.worktree_dir
        });
      }
    } finally {
      await removeDir(runtime.run_dir);
      await removeEmptyRunParent(path.dirname(runtime.run_dir));
    }
  }
}

function buildWorkspaceDiagnostics(input: {
  skippedEntries: import("../types.ts").MaterializationPlanEntry[];
  errors: string[];
}): WorkspaceDiagnostics | undefined {
  const diagnostics: WorkspaceDiagnostics = {};
  if (input.skippedEntries.length > 0) {
    diagnostics.skipped_entry_count = input.skippedEntries.length;
    diagnostics.skipped_entries = input.skippedEntries.slice(0, MAX_SKIPPED_ENTRY_DIAGNOSTICS);
  }
  if (input.errors.length > 0) {
    diagnostics.materialization_errors = input.errors;
  }
  return Object.keys(diagnostics).length > 0 ? diagnostics : undefined;
}

async function removeEmptyRunParent(runParentDir: string): Promise<void> {
  try {
    await rmdir(runParentDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") {
      throw error;
    }
  }
}
