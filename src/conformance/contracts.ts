import type {
  BackendName,
  CapabilityName,
  DeliveryMode,
  EnforcementSource
} from "../types.ts";
import type { PerformanceTier, ReasoningTier } from "../engine/types.ts";

export interface BackendCapabilityContract {
  delivery_mode: DeliveryMode;
  enforcement_source: EnforcementSource;
  reason?: string;
}

export interface BackendConformanceContract {
  backend: BackendName;
  supported_performance_tiers: PerformanceTier[];
  supported_reasoning_tiers: ReasoningTier[];
  capabilities: Record<CapabilityName, BackendCapabilityContract>;
}
