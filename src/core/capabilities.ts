export const CAPABILITY_NAMES = [
  "interactive_control_gates",
  "workspace_isolation",
  "durable_continuation",
  "structured_artifacts",
  "progress_observability",
  "execution_explainability",
  "delegated_execution",
  "external_tool_use",
  "policy_enforcement"
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];
export type CapabilityClass = "representational" | "workflow" | "enforcement";
export type CapabilityStatus = "satisfied" | "degraded" | "disabled" | "unavailable";
export type EnforcementSource = "framework" | "backend" | "mixed" | "none";
export type DeliveryMode = "native" | "managed" | "emulated" | "degraded";

export interface CapabilityDefinition {
  capability_class: CapabilityClass;
}

export interface CapabilityOutcome {
  status: CapabilityStatus;
  reason?: string;
}

export interface CapabilityDiagnostic {
  capability_class: CapabilityClass;
  enforcement_source: EnforcementSource;
  delivery_mode: DeliveryMode;
  compatibility_policy_path: string;
}

export const CAPABILITY_DEFINITIONS: Record<CapabilityName, CapabilityDefinition> = {
  interactive_control_gates: {
    capability_class: "enforcement"
  },
  workspace_isolation: {
    capability_class: "enforcement"
  },
  durable_continuation: {
    capability_class: "workflow"
  },
  structured_artifacts: {
    capability_class: "representational"
  },
  progress_observability: {
    capability_class: "representational"
  },
  execution_explainability: {
    capability_class: "representational"
  },
  delegated_execution: {
    capability_class: "workflow"
  },
  external_tool_use: {
    capability_class: "workflow"
  },
  policy_enforcement: {
    capability_class: "enforcement"
  }
};
