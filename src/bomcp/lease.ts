import type { ExecutionLease } from "./types.ts";
import { BOMCP_TOOL_NAMES } from "./types.ts";

export class LeaseValidator {
  private readonly lease: ExecutionLease;

  constructor(lease: ExecutionLease) {
    this.lease = lease;
  }

  validateToolCall(toolName: string): { allowed: true } | { allowed: false; reason: string } {
    if (this.isExpired()) {
      return { allowed: false, reason: "lease_expired" };
    }
    if (!this.lease.allowed_tools.includes(toolName)) {
      return { allowed: false, reason: `tool '${toolName}' not in lease` };
    }
    return { allowed: true };
  }

  isExpired(): boolean {
    if (!this.lease.expires_at) return false;
    return new Date(this.lease.expires_at).getTime() <= Date.now();
  }

  remainingSeconds(): number | undefined {
    if (!this.lease.expires_at) return undefined;
    const remaining = (new Date(this.lease.expires_at).getTime() - Date.now()) / 1000;
    return Math.max(0, remaining);
  }
}

export function buildLease(input: {
  executionId: string;
  allowedTools?: readonly string[];
  timeoutSeconds?: number;
}): ExecutionLease {
  const now = new Date();
  const allowed = input.allowedTools ?? [...BOMCP_TOOL_NAMES];
  return {
    execution_id: input.executionId,
    allowed_tools: allowed,
    timeout_seconds: input.timeoutSeconds,
    issued_at: now.toISOString(),
    expires_at: input.timeoutSeconds
      ? new Date(now.getTime() + input.timeoutSeconds * 1000).toISOString()
      : undefined,
  };
}
