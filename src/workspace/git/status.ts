import path from "node:path";
import { readFile } from "node:fs/promises";
import { runCommand } from "../../adapters/process.ts";
import { sha256 } from "../../utils.ts";
import { isRepoRelativePathInScope } from "../scope.ts";
import type { MaterializationPlanEntry } from "../../types.ts";

interface DiffNameStatusEntry {
  change: MaterializationPlanEntry["change"];
  repo_relative_path: string;
  previous_repo_relative_path?: string;
}

export async function collectGitMaterializationPlan(input: {
  repoRoot: string;
  worktreeDir: string;
  allowedRepoRelativeRoot: string;
  sourceCommit: string;
}): Promise<{
  entries: MaterializationPlanEntry[];
  skipped_entries: MaterializationPlanEntry[];
}> {
  const renameMap = await collectRenameEntries(input.worktreeDir, input.sourceCommit);
  const statusEntries = await collectStatusEntries(input.worktreeDir);
  const merged = mergeEntries(statusEntries, renameMap);
  const entries: MaterializationPlanEntry[] = [];
  const skipped_entries: MaterializationPlanEntry[] = [];

  for (const entry of merged) {
    const targetPath = entry.repo_relative_path;
    const previousPath = entry.previous_repo_relative_path;
    const inScope = isRepoRelativePathInScope(targetPath, input.allowedRepoRelativeRoot)
      || (previousPath ? isRepoRelativePathInScope(previousPath, input.allowedRepoRelativeRoot) : false);
    const digest = await computeEntryDigest(input.worktreeDir, entry);
    const normalized: MaterializationPlanEntry = {
      ...entry,
      digest
    };
    if (inScope) {
      entries.push(normalized);
    } else {
      skipped_entries.push(normalized);
    }
  }

  entries.sort(compareEntries);
  skipped_entries.sort(compareEntries);
  return { entries, skipped_entries };
}

async function collectRenameEntries(worktreeDir: string, sourceCommit: string): Promise<Map<string, DiffNameStatusEntry>> {
  const result = await runCommand({
    command: "git",
    args: ["diff", "--name-status", "-z", "--find-renames", sourceCommit],
    cwd: worktreeDir,
    timeoutMs: 60_000
  });
  if (result.exitCode !== 0) {
    throw new Error(`git diff --name-status failed: ${result.stderr || result.stdout}`);
  }
  const tokens = result.stdout.split("\0").filter(Boolean);
  const renames = new Map<string, DiffNameStatusEntry>();
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index];
    if (status.startsWith("R")) {
      const previous = tokens[index + 1];
      const next = tokens[index + 2];
      if (previous && next) {
        renames.set(next, {
          change: "rename",
          repo_relative_path: next,
          previous_repo_relative_path: previous
        });
      }
      index += 2;
    }
  }
  return renames;
}

async function collectStatusEntries(worktreeDir: string): Promise<DiffNameStatusEntry[]> {
  const result = await runCommand({
    command: "git",
    args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    cwd: worktreeDir,
    timeoutMs: 60_000
  });
  if (result.exitCode !== 0) {
    throw new Error(`git status failed: ${result.stderr || result.stdout}`);
  }
  const tokens = result.stdout.split("\0").filter(Boolean);
  const entries: DiffNameStatusEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const status = token.slice(0, 2);
    const firstPath = token.slice(3);
    if (status.startsWith("R")) {
      index += 1;
      continue;
    }
    entries.push({
      change: mapStatusToChange(status),
      repo_relative_path: firstPath
    });
  }
  return entries;
}

function mergeEntries(
  entries: DiffNameStatusEntry[],
  renameMap: Map<string, DiffNameStatusEntry>
): DiffNameStatusEntry[] {
  const merged: DiffNameStatusEntry[] = [];
  const renameSourcePaths = new Set(
    [...renameMap.values()]
      .map((rename) => rename.previous_repo_relative_path)
      .filter((value): value is string => typeof value === "string")
  );
  const emittedRenameTargets = new Set<string>();
  for (const entry of entries) {
    const renameEntry = renameMap.get(entry.repo_relative_path);
    if (renameEntry) {
      merged.push(renameEntry);
      emittedRenameTargets.add(renameEntry.repo_relative_path);
      continue;
    }
    if (renameSourcePaths.has(entry.repo_relative_path)) {
      continue;
    }
    merged.push(entry);
  }
  for (const [target, rename] of renameMap) {
    if (!emittedRenameTargets.has(target)) {
      merged.push(rename);
    }
  }
  return merged;
}

function mapStatusToChange(status: string): MaterializationPlanEntry["change"] {
  if (status === "??") {
    return "add";
  }
  const indexStatus = status[0] ?? " ";
  const worktreeStatus = status[1] ?? " ";
  if (worktreeStatus === "D") {
    return "delete";
  }
  if (indexStatus === "T" || worktreeStatus === "T") {
    return "type_change";
  }
  if (indexStatus === "A" || worktreeStatus === "A") {
    return "add";
  }
  if (indexStatus === "D") {
    return "delete";
  }
  return "modify";
}

async function computeEntryDigest(worktreeDir: string, entry: DiffNameStatusEntry): Promise<string> {
  if (entry.change === "delete") {
    return sha256(`delete:${entry.repo_relative_path}`);
  }
  const sourcePath = path.join(worktreeDir, entry.repo_relative_path);
  let content: Buffer;
  try {
    content = await readFile(sourcePath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read worktree entry for materialization digest: ${entry.repo_relative_path} (${reason})`);
  }
  return sha256(`${entry.change}:${entry.previous_repo_relative_path ?? ""}:${entry.repo_relative_path}:${content.toString("base64")}`);
}

function compareEntries(left: MaterializationPlanEntry, right: MaterializationPlanEntry): number {
  return `${left.previous_repo_relative_path ?? ""}:${left.repo_relative_path}`
    .localeCompare(`${right.previous_repo_relative_path ?? ""}:${right.repo_relative_path}`);
}
