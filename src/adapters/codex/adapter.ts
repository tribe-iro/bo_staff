import path from "node:path";
import type { AdapterEvent, BackendAdapter } from "../types.ts";
import { translateCodexTerminal } from "./translator.ts";
import { executeCliAdapter } from "../shared.ts";

export class CodexAdapter implements BackendAdapter {
  readonly backend = "codex" as const;

  async *execute(context: Parameters<BackendAdapter["execute"]>[0]): AsyncIterable<AdapterEvent> {
    const outputPath = path.join(context.workspace.run_dir, "codex-last-message.json");
    const args = buildCodexExecArgs(context, outputPath);
    yield* executeCliAdapter({
      context,
      command: "codex",
      args,
      initial_provider_session_id: context.session.provider_session_id,
      translate: ({ context: adapterContext, stdout, stderr }) =>
        translateCodexTerminal({
          context: adapterContext,
          stdout,
          stderr,
          finalMessagePath: outputPath
        })
    });
  }
}

export function buildCodexExecArgs(
  context: Parameters<BackendAdapter["execute"]>[0],
  outputPath: string
): string[] {
  const args = context.session.provider_session_id
    ? [
      "-C", context.workspace.runtime_working_directory,
      "exec",
      "resume"
    ]
    : [
      "-C", context.workspace.runtime_working_directory,
      "exec"
    ];

  args.push(
    "-c", `sandbox_mode=${JSON.stringify(context.request.workspace.sandbox)}`,
    "-c", `approval_policy=${JSON.stringify(context.request.policy.approvals === "forbid_interactive_approvals" ? "never" : "on-request")}`,
    "--skip-git-repo-check",
    "--json",
    "--output-last-message", outputPath,
    "--model", context.execution_profile.resolved_backend_model
  );
  if (context.execution_profile.resolved_backend_reasoning_control) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(context.execution_profile.resolved_backend_reasoning_control)}`);
  }
  if (context.session.provider_session_id) {
    args.push(context.session.provider_session_id);
  }
  return args;
}
