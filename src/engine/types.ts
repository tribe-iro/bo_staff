export const PERFORMANCE_TIERS = ["fast", "balanced", "high", "frontier"] as const;
export const REASONING_TIERS = ["none", "light", "standard", "deep"] as const;

export type PerformanceTier = (typeof PERFORMANCE_TIERS)[number];
export type ReasoningTier = (typeof REASONING_TIERS)[number];
