import path from "node:path";
import { cp, mkdir, rm } from "node:fs/promises";
import type { MaterializationPlanEntry } from "../../types.ts";
import { isPathInside, isRepoRelativePathInScope } from "../scope.ts";

export async function applyMaterializationPlan(input: {
  repoRoot: string;
  worktreeDir: string;
  allowedRepoRelativeRoot: string;
  entries: MaterializationPlanEntry[];
}): Promise<string[]> {
  const errors: string[] = [];
  for (const entry of input.entries) {
    try {
      await applyEntry(input.repoRoot, input.worktreeDir, input.allowedRepoRelativeRoot, entry);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}

async function applyEntry(
  repoRoot: string,
  worktreeDir: string,
  allowedRepoRelativeRoot: string,
  entry: MaterializationPlanEntry
): Promise<void> {
  if (!isRepoRelativePathInScope(entry.repo_relative_path, allowedRepoRelativeRoot)
    || (entry.previous_repo_relative_path && !isRepoRelativePathInScope(entry.previous_repo_relative_path, allowedRepoRelativeRoot))) {
    throw new Error(`Materialization entry escapes allowed workspace scope: ${entry.repo_relative_path}`);
  }
  const targetPath = resolvePathWithinRoot(repoRoot, entry.repo_relative_path, "target");
  if (entry.change === "delete") {
    await rm(targetPath, { recursive: true, force: true });
    return;
  }

  if (entry.change === "rename" && entry.previous_repo_relative_path) {
    const previousPath = resolvePathWithinRoot(repoRoot, entry.previous_repo_relative_path, "previous");
    await rm(previousPath, { recursive: true, force: true });
  }

  const sourcePath = resolvePathWithinRoot(worktreeDir, entry.repo_relative_path, "source");
  await mkdir(path.dirname(targetPath), { recursive: true });
  await cp(sourcePath, targetPath, { recursive: true, force: true });
}

function resolvePathWithinRoot(root: string, repoRelativePath: string, label: string): string {
  const resolvedPath = path.resolve(root, repoRelativePath);
  if (!isPathInside(root, resolvedPath)) {
    throw new Error(`Materialization ${label} path escapes root: ${repoRelativePath}`);
  }
  return resolvedPath;
}
