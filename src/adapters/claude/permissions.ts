import type { SandboxMode } from "../../types.ts";

const CLAUDE_PERMISSION_MODE_BY_SANDBOX: Record<SandboxMode, "dontAsk" | "bypassPermissions"> = {
  "read-only": "dontAsk",
  "workspace-write": "bypassPermissions",
  "danger-full-access": "bypassPermissions"
};

export function resolveClaudePermissionMode(sandbox: SandboxMode): "dontAsk" | "bypassPermissions" {
  return CLAUDE_PERMISSION_MODE_BY_SANDBOX[sandbox];
}
