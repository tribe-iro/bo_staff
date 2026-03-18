import type { IntegrationContext } from "../fixtures.ts";
import { project, runExplicitScenario, runNamedScenario, uniqueMarker } from "./common.ts";
import { runManagedProfile, runOverrideModel, runPinnedProfile, runTimeoutStress } from "./performance.ts";
import { runStructuredOutputScenario } from "./output-modes.ts";
import { runRejectedPreflightStreamScenario, runRejectedStreamScenario, runSuccessfulStreamScenario } from "./stream.ts";
import {
  managedContinuationToken,
  runForkContinuation,
  runInstructionDiscovery,
  runManagedContinuation,
  runNativeContinuation,
  runSessionDeletion,
  runUnknownSessionRejection
} from "./resume.ts";
import { runDeleteCleanup, runGitIsolatedDiscard, runGitIsolatedEdit, runNonGitIsolatedRejection, runWrite } from "./workspace.ts";
import { runAttachmentScenario, runPlanningScenario } from "./task.ts";

export async function runCodexScenarios(context: IntegrationContext): Promise<void> {
  const instructionMarker = uniqueMarker("CODX-INSTR");
  const nativeToken = uniqueMarker("CODX-NATIVE");
  await runNamedScenario(context, "codex.profile.fast.none", () =>
    runManagedProfile(context, "codex", project(context, "codex-read"), "fast", "none", "gpt-5.3-codex-spark", null, "codex-profile-fast-none"));
  await runNamedScenario(context, "codex.profile.high.deep", () =>
    runManagedProfile(context, "codex", project(context, "codex-read"), "high", "deep", "gpt-5.4", "high", "codex-profile-high-deep"));
  await runNamedScenario(context, "codex.profile.pinned", () =>
    runPinnedProfile(context, "codex", project(context, "codex-read"), "balanced", "standard", "gpt-5-codex", "medium", "codex-profile-pinned"));
  await runNamedScenario(context, "codex.profile.override", () =>
    runOverrideModel(context, "codex", project(context, "codex-read"), "gpt-5.4", "medium", "codex-profile-override"));
  await runNamedScenario(context, "codex.output.structured", () =>
    runStructuredOutputScenario(context, "codex", project(context, "codex-read"), "codex-structured-output"));
  await runNamedScenario(context, "codex.task.attachments", () =>
    runAttachmentScenario(context, "codex", project(context, "codex-task"), "inline-brief-codex", "file-brief-codex", "codex-attachments"));
  await runNamedScenario(context, "codex.task.planning", () =>
    runPlanningScenario(context, "codex", project(context, "codex-task"), "codex-planning"));
  await runNamedScenario(context, "codex.stream.success", () =>
    runSuccessfulStreamScenario(context, "codex", project(context, "codex-read"), "codex-stream-success"));
  await runNamedScenario(context, "codex.stream.rejected", () =>
    runRejectedStreamScenario(context, "codex", project(context, "codex-read"), "codex-stream-rejected"));
  await runNamedScenario(context, "codex.stream.preflight", () =>
    runRejectedPreflightStreamScenario(context, "codex", "codex-stream-preflight"));
  await runNamedScenario(context, "codex.instructions.discovery", () =>
    runInstructionDiscovery(context, "codex", project(context, "codex-read"), instructionMarker, "codex-read-instruction"));
  await runNamedScenario(context, "codex.session.native", () =>
    runNativeContinuation(context, "codex", project(context, "codex-session"), nativeToken, "codex-native"));
  await runNamedScenario(context, "codex.session.fork", () =>
    runForkContinuation(context, "codex", project(context, "codex-session"), uniqueMarker("CODX-FORK"), "codex-fork"));
  await runNamedScenario(context, "codex.session.delete", () =>
    runSessionDeletion(context, "codex", project(context, "codex-read"), "codex-session-delete"));
  await runNamedScenario(context, "codex.session.unknown", () =>
    runUnknownSessionRejection(context, "codex", project(context, "codex-read"), "codex-session-unknown"));
  await runNamedScenario(context, "codex.workspace.direct_write", () =>
    runWrite(context, "codex", project(context, "codex-write"), "created_by_codex.txt", "created-by-codex", "codex-write"));
  await runNamedScenario(context, "codex.workspace.git_apply", () =>
    runGitIsolatedEdit(context, "codex", project(context, "codex-isolated"), "tracked.txt", "tracked-codex-after", "codex-isolated"));
  await runNamedScenario(context, "codex.workspace.git_discard", () =>
    runGitIsolatedDiscard(context, "codex", project(context, "codex-discard"), "tracked.txt", "tracked-codex-discard-before", "tracked-codex-discard-after", "codex-discard"));
  await runNamedScenario(context, "codex.workspace.cleanup", () =>
    runDeleteCleanup(context, "codex", project(context, "codex-cleanup"), "codex-cleanup"));
  await runNamedScenario(context, "codex.workspace.non_git_rejected", () =>
    runNonGitIsolatedRejection(context, "codex", project(context, "non-git-isolated"), "codex-non-git-isolated"));
  await runExplicitScenario(context, "codex.runtime.timeout", () =>
    runTimeoutStress(context, "codex", project(context, "codex-read"), "codex-timeout"));

  if (context.agents.includes("claude")) {
    await runNamedScenario(context, "cross.codex_to_claude.managed", () =>
      runManagedContinuation(
        context,
        "codex",
        "claude",
        project(context, "codex-session"),
        managedContinuationToken("CODX-TO-CLD"),
        "codex-to-claude-managed"
      ));
  }
}

export async function runClaudeScenarios(context: IntegrationContext): Promise<void> {
  const instructionMarker = uniqueMarker("CLD-INSTR");
  const nativeToken = uniqueMarker("CLD-NATIVE");
  await runNamedScenario(context, "claude.profile.fast.none", () =>
    runManagedProfile(context, "claude", project(context, "claude-read"), "fast", "none", "claude-sonnet-4-6", null, "claude-profile-fast-none"));
  await runNamedScenario(context, "claude.profile.high.deep", () =>
    runManagedProfile(context, "claude", project(context, "claude-read"), "high", "deep", "claude-opus-4-6", "high", "claude-profile-high-deep"));
  await runNamedScenario(context, "claude.profile.pinned", () =>
    runPinnedProfile(context, "claude", project(context, "claude-read"), "balanced", "standard", "claude-sonnet-4-6", "medium", "claude-profile-pinned"));
  await runNamedScenario(context, "claude.profile.override", () =>
    runOverrideModel(context, "claude", project(context, "claude-read"), "claude-opus-4-6", "medium", "claude-profile-override"));
  await runNamedScenario(context, "claude.output.structured", () =>
    runStructuredOutputScenario(context, "claude", project(context, "claude-read"), "claude-structured-output"));
  await runNamedScenario(context, "claude.task.attachments", () =>
    runAttachmentScenario(context, "claude", project(context, "claude-task"), "inline-brief-claude", "file-brief-claude", "claude-attachments"));
  await runNamedScenario(context, "claude.task.planning", () =>
    runPlanningScenario(context, "claude", project(context, "claude-task"), "claude-planning"));
  await runNamedScenario(context, "claude.stream.success", () =>
    runSuccessfulStreamScenario(context, "claude", project(context, "claude-read"), "claude-stream-success"));
  await runNamedScenario(context, "claude.stream.rejected", () =>
    runRejectedStreamScenario(context, "claude", project(context, "claude-read"), "claude-stream-rejected"));
  await runNamedScenario(context, "claude.stream.preflight", () =>
    runRejectedPreflightStreamScenario(context, "claude", "claude-stream-preflight"));
  await runNamedScenario(context, "claude.instructions.discovery", () =>
    runInstructionDiscovery(context, "claude", project(context, "claude-read"), instructionMarker, "claude-read-instruction"));
  await runNamedScenario(context, "claude.session.native", () =>
    runNativeContinuation(context, "claude", project(context, "claude-session"), nativeToken, "claude-native"));
  await runNamedScenario(context, "claude.session.fork", () =>
    runForkContinuation(context, "claude", project(context, "claude-session"), uniqueMarker("CLD-FORK"), "claude-fork"));
  await runNamedScenario(context, "claude.session.delete", () =>
    runSessionDeletion(context, "claude", project(context, "claude-read"), "claude-session-delete"));
  await runNamedScenario(context, "claude.session.unknown", () =>
    runUnknownSessionRejection(context, "claude", project(context, "claude-read"), "claude-session-unknown"));
  await runNamedScenario(context, "claude.workspace.direct_write", () =>
    runWrite(context, "claude", project(context, "claude-write"), "created_by_claude.txt", "created-by-claude", "claude-write"));
  await runNamedScenario(context, "claude.workspace.git_apply", () =>
    runGitIsolatedEdit(context, "claude", project(context, "claude-isolated"), "tracked.txt", "tracked-claude-after", "claude-isolated"));
  await runNamedScenario(context, "claude.workspace.git_discard", () =>
    runGitIsolatedDiscard(context, "claude", project(context, "claude-discard"), "tracked.txt", "tracked-claude-discard-before", "tracked-claude-discard-after", "claude-discard"));
  await runNamedScenario(context, "claude.workspace.non_git_rejected", () =>
    runNonGitIsolatedRejection(context, "claude", project(context, "non-git-isolated"), "claude-non-git-isolated"));
  await runExplicitScenario(context, "claude.runtime.timeout", () =>
    runTimeoutStress(context, "claude", project(context, "claude-read"), "claude-timeout"));

  if (context.agents.includes("codex")) {
    await runNamedScenario(context, "cross.claude_to_codex.managed", () =>
      runManagedContinuation(
        context,
        "claude",
        "codex",
        project(context, "claude-session"),
        managedContinuationToken("CLD-TO-CODX"),
        "claude-to-codex-managed"
      ));
  }
}
