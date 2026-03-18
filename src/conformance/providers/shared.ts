import type { BackendConformanceContract } from "../contracts.ts";

type CapabilityMap = BackendConformanceContract["capabilities"];

export function createBaseCapabilities(): CapabilityMap {
  return {
    interactive_control_gates: {
      delivery_mode: "degraded",
      enforcement_source: "none"
    },
    workspace_isolation: {
      delivery_mode: "managed",
      enforcement_source: "framework"
    },
    durable_continuation: {
      delivery_mode: "native",
      enforcement_source: "backend"
    },
    structured_artifacts: {
      delivery_mode: "managed",
      enforcement_source: "framework"
    },
    progress_observability: {
      delivery_mode: "managed",
      enforcement_source: "framework"
    },
    execution_explainability: {
      delivery_mode: "managed",
      enforcement_source: "mixed"
    },
    delegated_execution: {
      delivery_mode: "degraded",
      enforcement_source: "none",
      reason: "Delegated execution is not yet exposed as substrate child execution."
    },
    external_tool_use: {
      delivery_mode: "native",
      enforcement_source: "mixed"
    },
    policy_enforcement: {
      delivery_mode: "native",
      enforcement_source: "mixed"
    }
  };
}
