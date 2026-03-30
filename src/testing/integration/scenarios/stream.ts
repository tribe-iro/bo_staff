import type { IntegrationContext } from "../fixtures.ts";
import { pauseStep } from "../fixtures.ts";
import { executeRawStream, executeStream } from "../assertions.ts";
import { buildRequest, type IntegrationAgent } from "./common.ts";

export async function runSuccessfulStreamScenario(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  prefix: string
) {
  await executeStream({
    context,
    name: prefix,
    request: buildRequest(backend, sourceRoot, "Set payload.content to stream-ok."),
    expectedHttp: 200,
    expectedTerminalKind: "execution.completed",
    expectedKinds: [
      "execution.started",
      "execution.completed"
    ]
  });
  await pauseStep(context);
}

export async function runRejectedStreamScenario(
  context: IntegrationContext,
  backend: IntegrationAgent,
  prefix: string
) {
  await executeStream({
    context,
    name: prefix,
    request: buildRequest(backend, "/no/such/workspace", "Set payload.content to impossible.", {
      workspace: {
        source_root: "/no/such/workspace"
      }
    }),
    expectedHttp: 200,
    expectedKinds: ["system.error"]
  });
  await pauseStep(context);
}

export async function runRejectedPreflightStreamScenario(
  context: IntegrationContext,
  backend: IntegrationAgent,
  prefix: string
) {
  const response = await executeRawStream({
    context,
    name: prefix,
    body: `{"backend":"${backend}","task":{"prompt":"broken"}`,
    expectedHttp: 200,
    expectedKinds: ["system.error"],
    contentType: "application/json"
  });
  const terminal = response.envelopes.at(-1);
  const terminalPayload = terminal?.payload as Record<string, unknown> | undefined;
  if (!terminal || terminalPayload?.code !== "invalid_json") {
    throw new Error(`${backend} stream preflight rejection should report invalid_json`);
  }
  await pauseStep(context);
}
