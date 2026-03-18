import type { BackendConformanceContract } from "../contracts.ts";
import { createBaseCapabilities } from "./shared.ts";

export const CLAUDE_CONFORMANCE: BackendConformanceContract = {
  backend: "claude",
  supported_performance_tiers: ["fast", "balanced", "high", "frontier"],
  supported_reasoning_tiers: ["none", "light", "standard", "deep"],
  capabilities: {
    ...createBaseCapabilities(),
    interactive_control_gates: {
      delivery_mode: "degraded",
      enforcement_source: "none",
      reason: "Claude CLI does not expose a reliable enforceable control-gate surface in this substrate."
    },
    policy_enforcement: {
      delivery_mode: "degraded",
      enforcement_source: "framework",
      reason: "Sandbox and control enforcement rely on framework-owned workspace boundaries."
    }
  }
};
