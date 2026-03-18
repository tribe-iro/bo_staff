import path from "node:path";
import type { IntegrationContext } from "../fixtures.ts";
import { pauseStep } from "../fixtures.ts";
import {
  assertCapabilityDegraded,
  assertCapabilityNotDegraded,
  assertContains,
  assertEq,
  assertFileContent,
  assertNoErrors,
  assertPathAbsent,
  executeRequest,
  fetchJson,
  getPayloadContent
} from "../assertions.ts";
import { buildRequest, type IntegrationAgent } from "./common.ts";

export async function runWrite(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  filename: string,
  expectedContent: string,
  prefix: string
) {
  const response = await executeRequest({
    context,
    name: prefix,
    request: buildRequest(
      backend,
      sourceRoot,
      `Using tools, create ${filename} in the current directory containing exactly '${expectedContent}'. Then reply with exactly ${filename}.`,
      {
        policy: {
          filesystem: "workspace_write"
        }
      }
    ),
    expectedHttp: 200,
    expectedStatuses: ["completed", "partial"]
  });
  assertContains(String(getPayloadContent(response.json)), filename, `${backend} direct write reply`);
  await assertFileContent(path.join(sourceRoot, filename), expectedContent);
  assertEq(response.json.workspace.writeback_status, "not_requested", `${backend} direct write writeback`);
  assertEq(response.json.workspace.materialization_status, "not_requested", `${backend} direct write materialization`);
  assertCapabilityDegraded(response.json, "workspace_isolation", `${backend} direct write`);
  assertNoErrors(response.json, `${backend} direct write`);
  await pauseStep(context);
}

export async function runGitIsolatedEdit(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  filename: string,
  expectedContent: string,
  prefix: string
) {
  const response = await executeRequest({
    context,
    name: prefix,
    request: buildRequest(
      backend,
      sourceRoot,
      `Using tools, modify ${filename} so it contains exactly '${expectedContent}'. Then reply with exactly ${filename}.`,
      {
        workspace: {
          source_root: sourceRoot,
          writeback: "apply"
        },
        policy: {
          isolation: "require_workspace_isolation",
          filesystem: "workspace_write"
        }
      }
    ),
    expectedHttp: 200,
    expectedStatuses: ["completed", "partial"]
  });
  await assertFileContent(path.join(sourceRoot, filename), expectedContent);
  assertEq(response.json.workspace.topology, "git_isolated", `${backend} git_isolated topology`);
  assertEq(response.json.workspace.writeback_status, "applied", `${backend} git_isolated writeback`);
  assertEq(response.json.workspace.materialization_status, "materialized", `${backend} git_isolated materialization`);
  assertCapabilityNotDegraded(response.json, "workspace_isolation", `${backend} git_isolated isolation`);
  assertNoErrors(response.json, `${backend} git_isolated write`);
  await pauseStep(context);
}

export async function runGitIsolatedDiscard(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  filename: string,
  originalContent: string,
  discardContent: string,
  prefix: string
) {
  const response = await executeRequest({
    context,
    name: prefix,
    request: buildRequest(
      backend,
      sourceRoot,
      `Using tools, modify ${filename} so it contains exactly '${discardContent}'. Then reply with exactly discard-ok.`,
      {
        workspace: {
          source_root: sourceRoot,
          writeback: "discard"
        },
        policy: {
          isolation: "require_workspace_isolation",
          filesystem: "workspace_write"
        }
      }
    ),
    expectedHttp: 200,
    expectedStatuses: ["completed", "partial"]
  });
  await assertFileContent(path.join(sourceRoot, filename), originalContent);
  assertEq(response.json.workspace.topology, "git_isolated", `${backend} discard topology`);
  assertEq(response.json.workspace.writeback_status, "discarded", `${backend} discard writeback`);
  assertEq(response.json.workspace.materialization_status, "not_requested", `${backend} discard materialization`);
  assertCapabilityNotDegraded(response.json, "workspace_isolation", `${backend} discard isolation`);
  assertContains(String(getPayloadContent(response.json)), "discard-ok", `${backend} discard reply`);
  assertNoErrors(response.json, `${backend} git_isolated discard`);
  await pauseStep(context);
}

export async function runDeleteCleanup(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  prefix: string
) {
  const response = await executeRequest({
    context,
    name: `${prefix}-create`,
    request: buildRequest(
      backend,
      sourceRoot,
      "Set payload.content to cleanup-ok.",
      {
        policy: {
          isolation: "require_workspace_isolation"
        }
      }
    ),
    expectedHttp: 200,
    expectedStatuses: ["completed", "partial"]
  });
  if (!response.json.session.handle) {
    throw new Error(`${prefix} cleanup scenario requires a persisted session handle`);
  }
  const worktreePath = path.join(context.dataDir, "worktrees", response.json.session.handle);
  await assertPathAbsent(worktreePath);
  const deleted = await fetchJson<{ deleted: boolean; handle: string }>({
    context,
    method: "DELETE",
    path: `/sessions/${encodeURIComponent(response.json.session.handle)}`,
    expectedHttp: 200,
    name: `${prefix}-delete`
  });
  assertEq(deleted.deleted, true, `${prefix} deleted`);
  await assertPathAbsent(worktreePath);
  await pauseStep(context);
}

export async function runNonGitIsolatedRejection(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  prefix: string
) {
  const response = await executeRequest({
    context,
    name: prefix,
    request: buildRequest(backend, sourceRoot, "Try an isolated write.", {
      policy: {
        isolation: "require_workspace_isolation"
      }
    }),
    expectedHttp: 400,
    expectedStatuses: ["rejected"]
  });
  assertContains(response.json.errors[0]?.message ?? "", "git repository", `${backend} non-git rejection`);
  await pauseStep(context);
}
