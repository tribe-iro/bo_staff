import type { IntegrationContext } from "../fixtures.ts";
import { pauseStep } from "../fixtures.ts";
import { assertEq, assertNoErrors, executeRequest } from "../assertions.ts";
import { buildRequest, type IntegrationAgent } from "./common.ts";

export async function runStructuredOutputScenario(
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
              status: { type: "string" }
            }
          }
        }
      }
    ),
    expectedHttp: 200,
    expectedStatuses: ["completed", "partial"]
  });
  const payload = response.json.result.payload as Record<string, unknown>;
  assertEq(payload.content, "structured-ok", `${backend} structured payload content`);
  assertEq(payload.status, "ok", `${backend} structured payload status`);
  assertNoErrors(response.json, `${backend} structured output`);
  await pauseStep(context);
}
