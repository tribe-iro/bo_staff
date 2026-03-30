import type { IntegrationContext } from "../fixtures.ts";
import { pauseStep } from "../fixtures.ts";
import {
  assertContains,
  assertNoPayloadErrors,
  executeRequest,
  getPayloadContent,
  requireTerminalEnvelope,
} from "../assertions.ts";
import { buildRequest, type IntegrationAgent } from "./common.ts";

export async function runManagedProfile(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  _profileTier: string,
  reasoningEffort: string | undefined,
  expectedModel: string,
  prefix: string
) {
  const result = await executeRequest({
    context,
    name: prefix,
    request: buildRequest(backend, sourceRoot, "Set payload.content to profile-ok.", {
      execution_profile: {
        model: expectedModel,
        reasoning_effort: reasoningEffort,
      },
    }),
    expectedHttp: 200,
    expectedTerminalKind: "execution.completed",
  });
  const terminal = requireTerminalEnvelope(result.envelopes, `${backend} managed profile`);
  assertContains(String(getPayloadContent(terminal)), "profile-ok", `${backend} managed profile reply`);
  assertNoPayloadErrors(terminal, `${backend} managed profile`);
  await pauseStep(context);
}

export async function runPinnedProfile(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  _profileTier: string,
  reasoningEffort: string | undefined,
  expectedModel: string,
  prefix: string
) {
  const result = await executeRequest({
    context,
    name: prefix,
    request: buildRequest(backend, sourceRoot, "Set payload.content to pinned-ok.", {
      execution_profile: {
        model: expectedModel,
        reasoning_effort: reasoningEffort,
      },
    }),
    expectedHttp: 200,
    expectedTerminalKind: "execution.completed",
  });
  const terminal = requireTerminalEnvelope(result.envelopes, `${backend} pinned profile`);
  assertContains(String(getPayloadContent(terminal)), "pinned-ok", `${backend} pinned profile reply`);
  assertNoPayloadErrors(terminal, `${backend} pinned profile`);
  await pauseStep(context);
}

export async function runOverrideModel(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  rawModel: string,
  prefix: string
) {
  const result = await executeRequest({
    context,
    name: prefix,
    request: buildRequest(backend, sourceRoot, "Set payload.content to override-ok.", {
      execution_profile: {
        model: rawModel,
        reasoning_effort: "medium",
      },
    }),
    expectedHttp: 200,
    expectedTerminalKind: "execution.completed",
  });
  const terminal = requireTerminalEnvelope(result.envelopes, `${backend} override profile`);
  assertContains(String(getPayloadContent(terminal)), "override-ok", `${backend} override reply`);
  assertNoPayloadErrors(terminal, `${backend} override profile`);
  await pauseStep(context);
}

export async function runTimeoutStress(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  prefix: string
) {
  const result = await executeRequest({
    context,
    name: prefix,
    request: buildRequest(
      backend,
      sourceRoot,
      "Set payload.content to timeout-never.",
      {
        runtime: {
          timeout_ms: 1,
        },
      }
    ),
    expectedHttp: 200,
    expectedTerminalKind: "execution.failed",
  });
  const terminal = requireTerminalEnvelope(result.envelopes, `${backend} timeout stress`);
  const payload = terminal.payload as Record<string, unknown>;
  const message = typeof payload?.message === "string" ? payload.message : "";
  assertContains(message, "timed out", `${backend} timeout stress`);
  await pauseStep(context);
}
