import type { IntegrationContext } from "../fixtures.ts";
import { project, runExplicitScenario, runNamedScenario, uniqueMarker } from "./common.ts";
import { runManagedProfile, runOverrideModel, runPinnedProfile, runTimeoutStress } from "./performance.ts";
import { runStructuredOutputScenario } from "./output-modes.ts";
import { runRejectedPreflightStreamScenario, runRejectedStreamScenario, runSuccessfulStreamScenario } from "./stream.ts";
import {
  runContinuationBackendMismatchRejection,
  runInstructionDiscovery,
  runNativeContinuation,
} from "./resume.ts";
import { runWrite } from "./workspace.ts";
import { runAttachmentScenario, runPlanningScenario } from "./task.ts";
import {
  runAdmissionSaturationScenario,
  runCancelMidflightScenario,
} from "./runtime.ts";
import {
  runProgressUpdateScenario,
  runArtifactRegisterScenario,
  runArtifactRegisterEscapeScenario,
  runArtifactRequireScenario,
  runInvalidParamsScenario,
  runHandoffScenario,
  runLeaseEnforcementScenario,
  runMultiCallScenario,
  runEnvelopeStructureScenario,
  runNamespaceReservationScenario,
} from "./bomcp.ts";

export async function runCodexScenarios(context: IntegrationContext): Promise<void> {
  const instructionMarker = uniqueMarker("CODX-INSTR");
  const nativeToken = uniqueMarker("CODX-NATIVE");
  await runNamedScenario(context, "codex.profile.fast.none", () =>
    runManagedProfile(context, "codex", project(context, "codex-read"), "fast", undefined, "gpt-5.3-codex-spark", "codex-profile-fast-none"));
  await runNamedScenario(context, "codex.profile.high.deep", () =>
    runManagedProfile(context, "codex", project(context, "codex-read"), "high", "high", "gpt-5.4", "codex-profile-high-deep"));
  await runNamedScenario(context, "codex.profile.pinned", () =>
    runPinnedProfile(context, "codex", project(context, "codex-read"), "balanced", "medium", "gpt-5-codex", "codex-profile-pinned"));
  await runNamedScenario(context, "codex.profile.override", () =>
    runOverrideModel(context, "codex", project(context, "codex-read"), "gpt-5.4", "codex-profile-override"));
  await runNamedScenario(context, "codex.output.structured", () =>
    runStructuredOutputScenario(context, "codex", project(context, "codex-read"), "codex-structured-output"));
  await runNamedScenario(context, "codex.task.attachments", () =>
    runAttachmentScenario(context, "codex", project(context, "codex-task"), "inline-brief-codex", "file-brief-codex", "codex-attachments"));
  await runNamedScenario(context, "codex.task.planning", () =>
    runPlanningScenario(context, "codex", project(context, "codex-task"), "codex-planning"));
  await runNamedScenario(context, "codex.stream.success", () =>
    runSuccessfulStreamScenario(context, "codex", project(context, "codex-read"), "codex-stream-success"));
  await runNamedScenario(context, "codex.stream.cancel_midflight", () =>
    runCancelMidflightScenario(context, "codex", project(context, "codex-read"), "codex-stream-cancel-midflight"));
  await runNamedScenario(context, "codex.stream.rejected", () =>
    runRejectedStreamScenario(context, "codex", "codex-stream-rejected"));
  await runNamedScenario(context, "codex.stream.preflight", () =>
    runRejectedPreflightStreamScenario(context, "codex", "codex-stream-preflight"));
  await runNamedScenario(context, "codex.instructions.discovery", () =>
    runInstructionDiscovery(context, "codex", project(context, "codex-read"), instructionMarker, "codex-read-instruction"));
  await runNamedScenario(context, "codex.continuation.native", () =>
    runNativeContinuation(context, "codex", project(context, "codex-session"), nativeToken, "codex-native"));
  await runNamedScenario(context, "codex.continuation.backend_mismatch", () =>
    runContinuationBackendMismatchRejection(context, "codex", project(context, "codex-read"), "codex-continuation-mismatch"));
  await runNamedScenario(context, "codex.workspace.direct_write", () =>
    runWrite(context, "codex", project(context, "codex-write"), "created_by_codex.txt", "created-by-codex", "codex-write"));
  await runExplicitScenario(context, "codex.runtime.timeout", () =>
    runTimeoutStress(context, "codex", project(context, "codex-read"), "codex-timeout"));
  await runNamedScenario(context, "codex.bomcp.envelope_structure", () =>
    runEnvelopeStructureScenario(context, "codex", project(context, "codex-read"), "codex-envelope-structure"));
  await runNamedScenario(context, "codex.bomcp.progress_update", () =>
    runProgressUpdateScenario(context, "codex", project(context, "codex-read"), "codex-progress-update"));
  await runNamedScenario(context, "codex.bomcp.handoff", () =>
    runHandoffScenario(context, "codex", project(context, "codex-read"), "codex-handoff"));
  await runNamedScenario(context, "codex.bomcp.invalid_params", () =>
    runInvalidParamsScenario(context, "codex", project(context, "codex-read"), "codex-invalid-params"));
  await runNamedScenario(context, "codex.bomcp.multi_call", () =>
    runMultiCallScenario(context, "codex", project(context, "codex-read"), "codex-multi-call"));
  await runNamedScenario(context, "codex.bomcp.artifact_register", () =>
    runArtifactRegisterScenario(context, "codex", project(context, "codex-write"), "codex-artifact-register"));
  await runNamedScenario(context, "codex.bomcp.artifact_register_escape", () =>
    runArtifactRegisterEscapeScenario(context, "codex", project(context, "codex-read"), "codex-artifact-register-escape"));
  await runNamedScenario(context, "codex.bomcp.artifact_require", () =>
    runArtifactRequireScenario(context, "codex", project(context, "codex-read"), "codex-artifact-require"));
  await runNamedScenario(context, "codex.bomcp.lease_enforcement", () =>
    runLeaseEnforcementScenario(context, "codex", project(context, "codex-read"), "codex-lease-enforcement"));
  await runNamedScenario(context, "codex.bomcp.namespace_reservation", () =>
    runNamespaceReservationScenario(context, "codex", "codex-namespace-reservation"));
  await runNamedScenario(context, "codex.runtime.admission_saturation", () =>
    runAdmissionSaturationScenario(context, "codex", project(context, "codex-read"), "codex-admission-saturation"));

}

export async function runClaudeScenarios(context: IntegrationContext): Promise<void> {
  const instructionMarker = uniqueMarker("CLD-INSTR");
  const nativeToken = uniqueMarker("CLD-NATIVE");
  await runNamedScenario(context, "claude.profile.fast.none", () =>
    runManagedProfile(context, "claude", project(context, "claude-read"), "fast", undefined, "claude-sonnet-4-6", "claude-profile-fast-none"));
  await runNamedScenario(context, "claude.profile.high.deep", () =>
    runManagedProfile(context, "claude", project(context, "claude-read"), "high", "high", "claude-opus-4-6", "claude-profile-high-deep"));
  await runNamedScenario(context, "claude.profile.pinned", () =>
    runPinnedProfile(context, "claude", project(context, "claude-read"), "balanced", "medium", "claude-sonnet-4-6", "claude-profile-pinned"));
  await runNamedScenario(context, "claude.profile.override", () =>
    runOverrideModel(context, "claude", project(context, "claude-read"), "claude-opus-4-6", "claude-profile-override"));
  await runNamedScenario(context, "claude.output.structured", () =>
    runStructuredOutputScenario(context, "claude", project(context, "claude-read"), "claude-structured-output"));
  await runNamedScenario(context, "claude.task.attachments", () =>
    runAttachmentScenario(context, "claude", project(context, "claude-task"), "inline-brief-claude", "file-brief-claude", "claude-attachments"));
  await runNamedScenario(context, "claude.task.planning", () =>
    runPlanningScenario(context, "claude", project(context, "claude-task"), "claude-planning"));
  await runNamedScenario(context, "claude.stream.success", () =>
    runSuccessfulStreamScenario(context, "claude", project(context, "claude-read"), "claude-stream-success"));
  await runNamedScenario(context, "claude.stream.cancel_midflight", () =>
    runCancelMidflightScenario(context, "claude", project(context, "claude-read"), "claude-stream-cancel-midflight"));
  await runNamedScenario(context, "claude.stream.rejected", () =>
    runRejectedStreamScenario(context, "claude", "claude-stream-rejected"));
  await runNamedScenario(context, "claude.stream.preflight", () =>
    runRejectedPreflightStreamScenario(context, "claude", "claude-stream-preflight"));
  await runNamedScenario(context, "claude.instructions.discovery", () =>
    runInstructionDiscovery(context, "claude", project(context, "claude-read"), instructionMarker, "claude-read-instruction"));
  await runNamedScenario(context, "claude.continuation.native", () =>
    runNativeContinuation(context, "claude", project(context, "claude-session"), nativeToken, "claude-native"));
  await runNamedScenario(context, "claude.continuation.backend_mismatch", () =>
    runContinuationBackendMismatchRejection(context, "claude", project(context, "claude-read"), "claude-continuation-mismatch"));
  await runNamedScenario(context, "claude.workspace.direct_write", () =>
    runWrite(context, "claude", project(context, "claude-write"), "created_by_claude.txt", "created-by-claude", "claude-write"));
  await runExplicitScenario(context, "claude.runtime.timeout", () =>
    runTimeoutStress(context, "claude", project(context, "claude-read"), "claude-timeout"));
  await runNamedScenario(context, "claude.bomcp.envelope_structure", () =>
    runEnvelopeStructureScenario(context, "claude", project(context, "claude-read"), "claude-envelope-structure"));
  await runNamedScenario(context, "claude.bomcp.progress_update", () =>
    runProgressUpdateScenario(context, "claude", project(context, "claude-read"), "claude-progress-update"));
  await runNamedScenario(context, "claude.bomcp.handoff", () =>
    runHandoffScenario(context, "claude", project(context, "claude-read"), "claude-handoff"));
  await runNamedScenario(context, "claude.bomcp.invalid_params", () =>
    runInvalidParamsScenario(context, "claude", project(context, "claude-read"), "claude-invalid-params"));
  await runNamedScenario(context, "claude.bomcp.multi_call", () =>
    runMultiCallScenario(context, "claude", project(context, "claude-read"), "claude-multi-call"));
  await runNamedScenario(context, "claude.bomcp.artifact_register", () =>
    runArtifactRegisterScenario(context, "claude", project(context, "claude-write"), "claude-artifact-register"));
  await runNamedScenario(context, "claude.bomcp.artifact_register_escape", () =>
    runArtifactRegisterEscapeScenario(context, "claude", project(context, "claude-read"), "claude-artifact-register-escape"));
  await runNamedScenario(context, "claude.bomcp.artifact_require", () =>
    runArtifactRequireScenario(context, "claude", project(context, "claude-read"), "claude-artifact-require"));
  await runNamedScenario(context, "claude.bomcp.lease_enforcement", () =>
    runLeaseEnforcementScenario(context, "claude", project(context, "claude-read"), "claude-lease-enforcement"));
  await runNamedScenario(context, "claude.bomcp.namespace_reservation", () =>
    runNamespaceReservationScenario(context, "claude", "claude-namespace-reservation"));
  await runNamedScenario(context, "claude.runtime.admission_saturation", () =>
    runAdmissionSaturationScenario(context, "claude", project(context, "claude-read"), "claude-admission-saturation"));
}
