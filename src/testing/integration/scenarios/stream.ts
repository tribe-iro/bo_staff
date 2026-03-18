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
    expectedTerminalEvent: "execution.snapshot",
    expectedEvents: [
      "execution.accepted",
      "execution.started",
      "execution.progress_initialized",
      "execution.progressed",
      "execution.completed",
      "execution.snapshot"
    ]
  });
  await pauseStep(context);
}

export async function runRejectedStreamScenario(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  prefix: string
) {
  await executeStream({
    context,
    name: prefix,
    request: buildRequest(backend, sourceRoot, "Set payload.content to impossible.", {
      policy: {
        isolation: "require_workspace_isolation"
      }
    }),
    expectedHttp: 200,
    expectedTerminalEvent: "execution.snapshot",
    expectedEvents: ["execution.rejected", "execution.snapshot"]
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
    expectedTerminalEvent: "execution.rejected",
    expectedEvents: ["execution.rejected"],
    contentType: "application/json"
  });
  const terminal = response.events.at(-1);
  if (!terminal || terminal.data.code !== "invalid_json") {
    throw new Error(`${backend} stream preflight rejection should report invalid_json`);
  }
  await pauseStep(context);
}
