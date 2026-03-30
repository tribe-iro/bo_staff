import type { NormalizedExecutionRequest } from "../types.ts";
import type { PromptEnvelope, PromptSection } from "./prompt-envelope.ts";

export async function buildExecutionPrompt(input: {
  request: NormalizedExecutionRequest;
}): Promise<PromptEnvelope> {
  const systemSections: PromptSection[] = [
    {
      label: "framework_preamble",
      content: [
        "You are running inside bo_staff, a governed execution substrate.",
        "Provider CLI permissions are fully permissive; bo_staff request validation, workspace scope, tool configuration, and lease rules are the governing contract you must follow."
      ].join(" ")
    },
    {
      label: "output_contract",
      content: [
        "Return exactly one JSON object matching this shape:",
        JSON.stringify({
          summary: "string",
          payload: "<must satisfy caller schema>",
          pending_items: ["string"],
          artifacts: [
            {
              artifact_id: "string",
              kind: "string",
              path: "string?",
              description: "string?",
              provenance: "framework|backend|caller",
              materialization_state: "materialized|cataloged|missing"
            }
          ]
        }, null, 2)
      ].join("\n")
    },
    {
      label: "output_schema",
      content: [
        `Caller output format: ${input.request.output.format}`,
        `Caller payload schema:\n${JSON.stringify(input.request.output.schema, null, 2)}`,
        `Schema enforcement requested: ${input.request.output.schema_enforcement}`
      ].join("\n")
    },
    {
      label: "workspace_context",
      content: [
        `Workspace topology: ${input.request.workspace.topology}`,
        `Workspace kind: ${input.request.workspace.kind}`,
        `Workspace scope mode: ${input.request.workspace.scope.mode}`
      ].join("\n")
    }
  ];

  if (input.request.task.constraints.length > 0) {
    systemSections.push({
      label: "task_constraints",
      content: `Task constraints:\n${JSON.stringify(input.request.task.constraints, null, 2)}`
    });
  }

  const userSections: PromptSection[] = [];
  if (input.request.task.objective) {
    userSections.push({
      label: "task_objective",
      content: `Task objective:\n${input.request.task.objective}`
    });
  }
  userSections.push({
    label: "task_prompt",
    content: `Task prompt:\n${input.request.task.prompt}`
  });
  if (Object.keys(input.request.task.context).length > 0) {
    userSections.push({
      label: "task_context",
      content: `Task context JSON:\n${JSON.stringify(input.request.task.context, null, 2)}`
    });
  }

  return {
    system: {
      sections: systemSections
    },
    user: {
      sections: userSections,
      attachments: input.request.task.attachments
    }
  };
}
