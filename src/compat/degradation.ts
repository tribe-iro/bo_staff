import type {
  CapabilityDiagnostic,
  CapabilityName,
  CapabilityOutcome
} from "../types.ts";
import { CAPABILITY_DEFINITIONS } from "../core/index.ts";

export function buildUnavailableOutcome(
  reason: string
): CapabilityOutcome {
  return {
    status: "unavailable",
    reason
  };
}

export function buildCapabilityDiagnostic(
  capability: CapabilityName,
  input: {
    enforcement_source: CapabilityDiagnostic["enforcement_source"];
    delivery_mode: CapabilityDiagnostic["delivery_mode"];
    compatibility_policy_path: string;
  }
): CapabilityDiagnostic {
  const definition = CAPABILITY_DEFINITIONS[capability];
  return {
    capability_class: definition.capability_class,
    enforcement_source: input.enforcement_source,
    delivery_mode: input.delivery_mode,
    compatibility_policy_path: input.compatibility_policy_path
  };
}
