import { resolveGitRepositoryContext } from "../workspace/git/resolve-repo.ts";
import { removeDetachedWorktree, worktreePath } from "../workspace/git/worktree.ts";
import { removeDir } from "../utils.ts";
import type { BoStaffRepository } from "../persistence/types.ts";

export async function deleteSessionWithResources(input: {
  dataDir: string;
  repository: BoStaffRepository;
  handle: string;
}): Promise<boolean> {
  const existing = await input.repository.getSession(input.handle);
  if (!existing) {
    return false;
  }
  if (existing.workspace_topology === "git_isolated") {
    const retainedWorktreePath = worktreePath(input.dataDir, input.handle);
    const repoContext = existing.source_root
      ? await resolveGitRepositoryContext(existing.source_root)
      : undefined;
    if (repoContext) {
      await removeDetachedWorktree({
        repoRoot: repoContext.repo_root,
        worktreeDir: retainedWorktreePath
      });
    }
    await removeDir(retainedWorktreePath);
  }
  return input.repository.deleteSession(input.handle);
}
