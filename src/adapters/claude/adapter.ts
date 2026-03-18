import type { AdapterEvent, BackendAdapter } from "../types.ts";
import { translateClaudeTerminal } from "./translator.ts";
import { resolveClaudePermissionMode } from "./permissions.ts";
import { executeCliAdapter } from "../shared.ts";

export class ClaudeAdapter implements BackendAdapter {
  readonly backend = "claude" as const;

  async *execute(context: Parameters<BackendAdapter["execute"]>[0]): AsyncIterable<AdapterEvent> {
    const args = [
      "-p",
      "--output-format", "json",
      "--permission-mode",
      resolveClaudePermissionMode(context.request.workspace.sandbox),
      "--model", context.execution_profile.resolved_backend_model
    ];

    if (context.execution_profile.resolved_backend_reasoning_control) {
      args.push("--effort", context.execution_profile.resolved_backend_reasoning_control);
    }
    if (context.session.provider_session_id) {
      args.push("--resume", context.session.provider_session_id);
    }

    yield* executeCliAdapter({
      context,
      command: "claude",
      args,
      initial_provider_session_id: context.session.provider_session_id,
      translate: ({ context: adapterContext, stdout, stderr }) =>
        translateClaudeTerminal({
          context: adapterContext,
          stdout,
          stderr
        })
    });
  }
}
