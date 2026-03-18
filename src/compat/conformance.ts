import type {
  CapabilityDiagnostic,
  CapabilityName,
  CapabilityOutcome
} from "../types.ts";
import { CAPABILITY_NAMES } from "../core/index.ts";
import { buildCapabilityDiagnostic } from "./degradation.ts";
import { getConformanceContract } from "../conformance/matrix.ts";

export function resolveCapabilityOutcomes(input: {
  backend: "codex" | "claude";
}): {
  outcomes: Record<CapabilityName, CapabilityOutcome>;
  diagnostics: Record<CapabilityName, CapabilityDiagnostic>;
} {
  const contract = getConformanceContract(input.backend);
  const outcomes = {} as Record<CapabilityName, CapabilityOutcome>;
  const diagnostics = {} as Record<CapabilityName, CapabilityDiagnostic>;

  for (const capability of CAPABILITY_NAMES) {
    const backendSupport = contract.capabilities[capability];
    outcomes[capability] = {
      status: backendSupport.delivery_mode === "degraded" ? "degraded" : "satisfied",
      reason: backendSupport.reason
    };
    diagnostics[capability] = buildCapabilityDiagnostic(capability, {
      enforcement_source: backendSupport.enforcement_source,
      delivery_mode: backendSupport.delivery_mode,
      compatibility_policy_path: "compat.conformance.resolve_capability_outcomes"
    });
  }

  return { outcomes, diagnostics };
}
