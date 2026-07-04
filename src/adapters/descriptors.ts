import type { BackendName, ToolPolicyMode } from "../types.ts";

export interface CliAgentCapabilities {
  cwd_control: true;
  event_streaming: true;
  structured_output_normalization: "engine";
  cancellation: true;
  continuation: boolean;
  mcp_injection: boolean;
  custom_output_schema: boolean;
  builtin_tool_policy_modes: readonly ToolPolicyMode[];
}

export interface CliAgentDescriptor {
  backend: BackendName;
  executable: string;
  default_model: string;
  auto_select_rank: number;
  capabilities: CliAgentCapabilities;
}

const SHARED_CAPABILITIES = {
  cwd_control: true,
  event_streaming: true,
  structured_output_normalization: "engine",
  cancellation: true,
  continuation: true,
  mcp_injection: true,
  custom_output_schema: true,
} as const;

export const CLI_AGENT_DESCRIPTORS: readonly CliAgentDescriptor[] = [
  {
    backend: "claude",
    executable: "claude",
    default_model: "claude-sonnet-4-6",
    auto_select_rank: 0,
    capabilities: {
      ...SHARED_CAPABILITIES,
      builtin_tool_policy_modes: ["default", "allowlist", "denylist"],
    },
  },
  {
    backend: "codex",
    executable: "codex",
    default_model: "gpt-5.5",
    auto_select_rank: 1,
    capabilities: {
      ...SHARED_CAPABILITIES,
      builtin_tool_policy_modes: ["default"],
    },
  },
] as const;

const DESCRIPTORS_BY_BACKEND = new Map(CLI_AGENT_DESCRIPTORS.map((descriptor) => [descriptor.backend, descriptor]));

export function getCliAgentDescriptor(backend: BackendName): CliAgentDescriptor | undefined {
  return DESCRIPTORS_BY_BACKEND.get(backend);
}

export function requireCliAgentDescriptor(backend: BackendName): CliAgentDescriptor {
  const descriptor = getCliAgentDescriptor(backend);
  if (!descriptor) {
    throw new Error(`missing CLI agent descriptor for ${backend}`);
  }
  return descriptor;
}
