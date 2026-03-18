import type { BackendConformanceContract } from "../contracts.ts";
import { createBaseCapabilities } from "./shared.ts";

export const CODEX_CONFORMANCE: BackendConformanceContract = {
  backend: "codex",
  supported_performance_tiers: ["fast", "balanced", "high", "frontier"],
  supported_reasoning_tiers: ["none", "light", "standard", "deep"],
  capabilities: {
    ...createBaseCapabilities(),
    interactive_control_gates: {
      delivery_mode: "degraded",
      enforcement_source: "none",
      reason: "Codex CLI exposes on-request approvals but does not provide a distinct required control-gate mode."
    },
  }
};
