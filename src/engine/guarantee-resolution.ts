import type {
  CapabilityDiagnostic,
  CapabilityName,
  CapabilityOutcome,
  NormalizedExecutionRequest
} from "../types.ts";
import { resolveCapabilityOutcomes } from "../compat/conformance.ts";
import { buildCapabilityDiagnostic } from "../compat/degradation.ts";

export function resolveGuarantees(input: {
  request: NormalizedExecutionRequest;
}): {
  outcomes: Record<CapabilityName, CapabilityOutcome>;
  diagnostics: Record<CapabilityName, CapabilityDiagnostic>;
} {
  const resolved = resolveCapabilityOutcomes({
    backend: input.request.backend
  });
  let outcomes = resolved.outcomes;
  let diagnostics = resolved.diagnostics;

  if (input.request.backend === "claude" && input.request.workspace.sandbox === "read-only") {
    outcomes = {
      ...outcomes,
      policy_enforcement: {
        ...outcomes.policy_enforcement,
        reason: describeClaudePolicyEnforcementGap(input.request)
      }
    };
    diagnostics = {
      ...diagnostics,
      policy_enforcement: buildCapabilityDiagnostic("policy_enforcement", {
        enforcement_source: diagnostics.policy_enforcement.enforcement_source,
        delivery_mode: diagnostics.policy_enforcement.delivery_mode,
        compatibility_policy_path: "engine.guarantee_resolution.claude_read_only_sandbox"
      })
    };
  }

  if (input.request.session.mode === "ephemeral") {
    outcomes = {
      ...outcomes,
      durable_continuation: {
        status: "degraded",
        reason: "session.mode=ephemeral does not provide durable continuation."
      }
    };
    diagnostics = {
      ...diagnostics,
      durable_continuation: buildCapabilityDiagnostic("durable_continuation", {
        enforcement_source: "none",
        delivery_mode: "degraded",
        compatibility_policy_path: "engine.guarantee_resolution.ephemeral_session"
      })
    };
  }

  if (input.request.workspace.topology === "direct") {
    outcomes = {
      ...outcomes,
      workspace_isolation: {
        status: "degraded",
        reason: "Direct topology does not provide substrate-managed workspace isolation."
      }
    };
    diagnostics = {
      ...diagnostics,
      workspace_isolation: buildCapabilityDiagnostic("workspace_isolation", {
        enforcement_source: "none",
        delivery_mode: "degraded",
        compatibility_policy_path: "engine.guarantee_resolution.direct_workspace"
      })
    };
  }

  if (input.request.policy.approvals === "forbid_interactive_approvals") {
    outcomes = {
      ...outcomes,
      interactive_control_gates: {
        status: "disabled",
        reason: "Interactive approvals were explicitly forbidden by policy."
      }
    };
  }

  return {
    outcomes,
    diagnostics
  };
}

function describeClaudePolicyEnforcementGap(request: NormalizedExecutionRequest): string {
  return request.workspace.topology === "direct"
    ? "Claude direct read-only sandboxing is not a substrate-verifiable guarantee; bo_staff relies on provider permission semantics outside framework control."
    : "Claude policy enforcement relies on coarse provider permission modes plus framework-managed workspace boundaries.";
}
