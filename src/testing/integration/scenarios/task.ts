import path from "node:path";
import type { IntegrationContext } from "../fixtures.ts";
import { pauseStep } from "../fixtures.ts";
import {
  assertArtifactKinds,
  assertEq,
  assertNoErrors,
  executeRequest,
  getPayloadRecord
} from "../assertions.ts";
import { buildRequest, type IntegrationAgent } from "./common.ts";

export async function runAttachmentScenario(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  expectedInline: string,
  expectedFile: string,
  prefix: string
) {
  const response = await executeRequest({
    context,
    name: prefix,
    request: buildRequest(
      backend,
      sourceRoot,
      [
        "Read both attachments.",
        "The inline attachment contains one token and the file attachment contains another token.",
        "Return content as the exact concatenation of the actual attachment contents in the form inline_token|file_token.",
        "Do not return placeholder text such as <inline> or <file>.",
        "Set artifact_label to exactly 'attachment-proof'."
      ].join(" "),
      {
        task: {
          objective: "Demonstrate that bo_staff attachment material is available to the agent.",
          constraints: [
            "Do not use tools.",
            "Use only the attachment material.",
            "The content field must be the literal attachment values joined by a single pipe."
          ],
          attachments: [
            {
              name: "inline-note.txt",
              content: expectedInline
            },
            {
              name: "file-note.txt",
              path: path.join(sourceRoot, "brief.txt")
            }
          ]
        },
        output: {
          format: "custom",
          schema: {
            type: "object",
            required: ["content", "artifact_label"],
            additionalProperties: false,
            properties: {
              content: { type: "string" },
              artifact_label: { type: "string" }
            }
          }
        }
      }
    ),
    expectedHttp: 200,
    expectedStatuses: ["completed", "partial"]
  });
  const payload = getPayloadRecord(response.json);
  assertEq(payload.content, `${expectedInline}|${expectedFile}`, `${backend} attachment payload`);
  assertEq(payload.artifact_label, "attachment-proof", `${backend} attachment artifact_label`);
  assertNoErrors(response.json, `${backend} attachments`);
  await pauseStep(context);
}

export async function runPlanningScenario(
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
      "Create a compact implementation plan. Return exactly three ordered steps, a final decision='feasible', and include one artifact record of kind 'plan'.",
      {
        task: {
          objective: "Plan a safe implementation sequence.",
          constraints: [
            "Exactly three steps.",
            "Keep each step short.",
            "Do not use tools."
          ]
        },
        output: {
          format: "custom",
          schema: {
            type: "object",
            required: ["steps", "decision"],
            additionalProperties: false,
            properties: {
              steps: {
                type: "array",
                items: { type: "string" }
              },
              decision: { type: "string" }
            }
          }
        }
      }
    ),
    expectedHttp: 200,
    expectedStatuses: ["completed", "partial"]
  });
  const payload = getPayloadRecord(response.json);
  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  if (steps.length !== 3 || !steps.every((step) => typeof step === "string" && step.trim().length > 0)) {
    throw new Error(`${backend} planning scenario: expected exactly three non-empty steps`);
  }
  assertEq(payload.decision, "feasible", `${backend} planning decision`);
  assertArtifactKinds(response.json, ["plan"], `${backend} planning artifacts`);
  assertNoErrors(response.json, `${backend} planning`);
  await pauseStep(context);
}
