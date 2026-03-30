import type { IntegrationContext } from "../fixtures.ts";
import { pauseStep } from "../fixtures.ts";
import {
  assertEq,
  assertNoPayloadErrors,
  executeRequest,
  getAgentOutput,
  requireTerminalEnvelope,
} from "../assertions.ts";
import { buildRequest, type IntegrationAgent } from "./common.ts";

export async function runStructuredOutputScenario(
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
      "Reply with content='structured-ok' and status='ok'.",
      {
        output: {
          format: "custom",
          schema: {
            type: "object",
            required: ["content", "status"],
            additionalProperties: false,
            properties: {
              content: { type: "string" },
              status: { type: "string" },
            },
          },
        },
      }
    ),
    expectedHttp: 200,
    expectedTerminalKind: "execution.completed",
  });
  const terminal = requireTerminalEnvelope(result.envelopes, `${backend} structured output`);
  const output = getAgentOutput(terminal);
  assertEq(output.content, "structured-ok", `${backend} structured payload content`);
  assertEq(output.status, "ok", `${backend} structured payload status`);
  assertNoPayloadErrors(terminal, `${backend} structured output`);
  await pauseStep(context);
}
