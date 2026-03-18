import type { IntegrationContext } from "../fixtures.ts";
import { pauseStep } from "../fixtures.ts";
import { assertContains, assertExecutionProfile, assertNoErrors, executeRequest, getPayloadContent } from "../assertions.ts";
import { buildRequest, type IntegrationAgent } from "./common.ts";

export async function runManagedProfile(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  performanceTier: "fast" | "balanced" | "high" | "frontier",
  reasoningTier: "none" | "light" | "standard" | "deep",
  expectedModel: string,
  expectedReasoningControl: string | null,
  prefix: string
) {
  const response = await executeRequest({
    context,
    name: prefix,
    request: buildRequest(backend, sourceRoot, "Set payload.content to profile-ok.", {
      execution_profile: {
        performance_tier: performanceTier,
        reasoning_tier: reasoningTier,
        selection_mode: "managed"
      }
    }),
    expectedHttp: 200,
    expectedStatuses: ["completed", "partial"]
  });
  assertContains(String(getPayloadContent(response.json)), "profile-ok", `${backend} managed profile reply`);
  assertExecutionProfile(response.json.execution_profile, {
    selection_mode: "managed",
    resolution_source: "managed",
    resolved_backend_model: expectedModel,
    resolved_backend_reasoning_control: expectedReasoningControl
  }, `${backend} managed profile`);
  assertNoErrors(response.json, `${backend} managed profile`);
  await pauseStep(context);
}

export async function runPinnedProfile(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  performanceTier: "fast" | "balanced" | "high" | "frontier",
  reasoningTier: "none" | "light" | "standard" | "deep",
  expectedModel: string,
  expectedReasoningControl: string | null,
  prefix: string
) {
  const response = await executeRequest({
    context,
    name: prefix,
    request: buildRequest(backend, sourceRoot, "Set payload.content to pinned-ok.", {
      execution_profile: {
        performance_tier: performanceTier,
        reasoning_tier: reasoningTier,
        selection_mode: "pinned",
        pin: "2026-03-14"
      }
    }),
    expectedHttp: 200,
    expectedStatuses: ["completed", "partial"]
  });
  assertContains(String(getPayloadContent(response.json)), "pinned-ok", `${backend} pinned profile reply`);
  assertExecutionProfile(response.json.execution_profile, {
    selection_mode: "pinned",
    resolution_source: "pinned",
    resolved_backend_model: expectedModel,
    resolved_backend_reasoning_control: expectedReasoningControl
  }, `${backend} pinned profile`);
  assertNoErrors(response.json, `${backend} pinned profile`);
  await pauseStep(context);
}

export async function runOverrideModel(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  rawModel: string,
  expectedReasoningControl: string | null,
  prefix: string
) {
  const response = await executeRequest({
    context,
    name: prefix,
    request: buildRequest(backend, sourceRoot, "Set payload.content to override-ok.", {
      execution_profile: {
        selection_mode: "override",
        override: rawModel,
        reasoning_tier: "standard"
      }
    }),
    expectedHttp: 200,
    expectedStatuses: ["completed", "partial"]
  });
  assertContains(String(getPayloadContent(response.json)), "override-ok", `${backend} override reply`);
  assertExecutionProfile(response.json.execution_profile, {
    selection_mode: "override",
    resolution_source: "override",
    resolved_backend_model: rawModel,
    resolved_backend_reasoning_control: expectedReasoningControl
  }, `${backend} override profile`);
  assertNoErrors(response.json, `${backend} override profile`);
  await pauseStep(context);
}

export async function runTimeoutStress(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  prefix: string
) {
  const response = await executeRequest({
    context,
    name: prefix,
    request: buildRequest(
      backend,
      sourceRoot,
      "Set payload.content to timeout-never.",
      {
        runtime: {
          timeout_ms: 1
        }
      }
    ),
    expectedHttp: 502,
    expectedStatuses: ["failed"]
  });
  assertContains(response.json.errors[0]?.message ?? "", "timed out", `${backend} timeout stress`);
  await pauseStep(context);
}
