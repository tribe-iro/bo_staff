import path from "node:path";
import { realpath } from "node:fs/promises";

export interface WorkspaceScopeDescriptor {
  source_root: string | null;
  scope: {
    mode: "full" | "subpath";
    subpath?: string;
  };
}

export function resolveWorkspaceScopeRoot(input: WorkspaceScopeDescriptor): string {
  if (input.scope.mode !== "subpath" || !input.scope.subpath) {
    return input.source_root ?? "";
  }
  if (!input.source_root) {
    throw new Error("workspace.scope.mode=subpath requires a concrete source_root");
  }
  return path.resolve(input.source_root, input.scope.subpath);
}

export function isWorkspaceScopeContainedWithinSourceRoot(input: WorkspaceScopeDescriptor): boolean {
  const sourceRoot = input.source_root;
  return typeof sourceRoot === "string" && isPathInside(sourceRoot, resolveWorkspaceScopeRoot(input));
}

export function isPathInside(root: string, candidate: string): boolean {
  if (!root || !candidate) {
    return false;
  }
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export type ContainedRealPathResolution =
  | { status: "contained"; path: string }
  | { status: "missing" }
  | { status: "outside" };

export async function resolveContainedRealPath(root: string, candidate: string): Promise<ContainedRealPathResolution> {
  if (!root || !candidate) {
    return { status: "missing" };
  }
  try {
    const [resolvedRoot, resolvedCandidate] = await Promise.all([
      realpath(root),
      realpath(candidate)
    ]);
    return isPathInside(resolvedRoot, resolvedCandidate)
      ? { status: "contained", path: resolvedCandidate }
      : { status: "outside" };
  } catch (error) {
    return isMissingPathError(error) ? { status: "missing" } : { status: "outside" };
  }
}

export function toRepoRelativeScopeRoot(repoRoot: string, absoluteScopeRoot: string): string {
  if (!isPathInside(repoRoot, absoluteScopeRoot)) {
    throw new Error(`Scoped workspace root escapes repository root: ${absoluteScopeRoot}`);
  }
  return path.relative(repoRoot, absoluteScopeRoot) || ".";
}

export function isRepoRelativePathInScope(repoRelativePath: string, allowedRepoRelativeRoot: string): boolean {
  const normalizedPath = normalizeRepoRelativePath(repoRelativePath);
  const normalizedRoot = normalizeRepoRelativePath(allowedRepoRelativeRoot);
  if (!normalizedRoot) {
    return true;
  }
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function normalizeRepoRelativePath(value: string): string {
  return value === "."
    ? ""
    : value.replaceAll(path.sep, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
