import path from "node:path";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type {
  BackendName,
  NormalizedExecutionRequest,
  ResolvedExecutionProfile
} from "../types.ts";
import { BACKEND_NAMES } from "../types/api.ts";
import {
  PERFORMANCE_TIERS,
  REASONING_TIERS,
  type PerformanceTier,
  type ReasoningTier
} from "../engine/types.ts";
import { fileFingerprint } from "../utils.ts";

interface ReasoningMapping {
  control?: string;
}

interface ProviderProfileSnapshot {
  performance_tiers: Record<PerformanceTier, string>;
  reasoning_tiers: Record<ReasoningTier, ReasoningMapping>;
}

interface ProviderProfileConfig {
  managed: ProviderProfileSnapshot;
  pins?: Record<string, ProviderProfileSnapshot>;
}

interface ExecutionProfilesConfig {
  version: string;
  providers: Record<BackendName, ProviderProfileConfig>;
}

const cache = new Map<string, {
  fingerprint: string;
  result: Promise<ExecutionProfilesConfig>;
}>();
const MAX_CACHE_ENTRIES = 4;

export async function loadExecutionProfiles(filePath?: string): Promise<ExecutionProfilesConfig> {
  const resolvedPath = path.resolve(filePath ?? path.join(process.cwd(), "config", "provider-profiles.yaml"));
  const fingerprint = await fileFingerprint(resolvedPath);
  const cached = cache.get(resolvedPath);
  if (cached?.fingerprint === fingerprint) {
    return cached.result;
  }

  const pending = (async () => {
    const raw = await readFile(resolvedPath, "utf8");
    const parsed = parse(raw) as unknown;
    assertExecutionProfilesConfig(parsed);
    return parsed;
  })();

  cache.set(resolvedPath, {
    fingerprint,
    result: pending
  });
  trimCache();

  try {
    return await pending;
  } catch (error) {
    const active = cache.get(resolvedPath);
    if (active?.result === pending) {
      cache.delete(resolvedPath);
    }
    throw error;
  }
}

export async function resolveExecutionProfile(input: {
  request: NormalizedExecutionRequest;
  profilesFile?: string;
}): Promise<ResolvedExecutionProfile> {
  const config = await loadExecutionProfiles(input.profilesFile);
  const provider = config.providers[input.request.backend];
  const requestedPerformanceTier = input.request.execution_profile.performance_tier;
  const requestedReasoningTier = input.request.execution_profile.reasoning_tier;
  const selectionMode = input.request.execution_profile.selection_mode;

  let snapshot: ProviderProfileSnapshot;
  let resolutionSource: ResolvedExecutionProfile["resolution_source"] = selectionMode;
  if (selectionMode === "pinned") {
    const pin = input.request.execution_profile.pin;
    if (!pin) {
      throw new Error("Pinned execution profiles require execution_profile.pin");
    }
    snapshot = provider.pins?.[pin] ?? fail(`Unknown execution profile pin '${pin}' for backend ${input.request.backend}`);
  } else {
    snapshot = provider.managed;
  }

  const resolvedBackendModel = selectionMode === "override"
    ? input.request.execution_profile.override ?? fail("Override execution profiles require execution_profile.override")
    : snapshot.performance_tiers[requestedPerformanceTier];
  const resolvedBackendReasoningControl = snapshot.reasoning_tiers[requestedReasoningTier]?.control;

  return {
    requested_performance_tier: requestedPerformanceTier,
    requested_reasoning_tier: requestedReasoningTier,
    selection_mode: selectionMode,
    resolved_backend_model: resolvedBackendModel,
    resolved_backend_reasoning_control: resolvedBackendReasoningControl,
    resolution_source: resolutionSource
  };
}

function assertExecutionProfilesConfig(value: unknown): asserts value is ExecutionProfilesConfig {
  if (!value || typeof value !== "object") {
    throw new Error("Execution profiles config must be an object");
  }
  const config = value as Partial<ExecutionProfilesConfig>;
  if (typeof config.version !== "string") {
    throw new Error("Execution profiles config requires version");
  }
  const providers = config.providers;
  if (!providers || typeof providers !== "object") {
    throw new Error("Execution profiles config requires providers");
  }
  for (const backend of BACKEND_NAMES) {
    const profile = providers[backend];
    if (!profile || typeof profile !== "object") {
      throw new Error(`Missing execution profile for backend ${backend}`);
    }
    assertSnapshot(profile.managed, `${backend}.managed`);
    if (profile.pins && typeof profile.pins === "object") {
      for (const [pin, snapshot] of Object.entries(profile.pins)) {
        assertSnapshot(snapshot, `${backend}.pins.${pin}`);
      }
    }
  }
}

function assertSnapshot(value: unknown, pathLabel: string): asserts value is ProviderProfileSnapshot {
  if (!value || typeof value !== "object") {
    throw new Error(`Execution profile snapshot ${pathLabel} must be an object`);
  }
  const snapshot = value as Partial<ProviderProfileSnapshot>;
  for (const tier of PERFORMANCE_TIERS) {
    if (typeof snapshot.performance_tiers?.[tier] !== "string") {
      throw new Error(`Execution profile snapshot ${pathLabel} is missing performance tier ${tier}`);
    }
  }
  for (const tier of REASONING_TIERS) {
    const mapping = snapshot.reasoning_tiers?.[tier];
    if (!mapping || typeof mapping !== "object") {
      throw new Error(`Execution profile snapshot ${pathLabel} is missing reasoning tier ${tier}`);
    }
    if ("control" in mapping && mapping.control !== undefined && typeof mapping.control !== "string") {
      throw new Error(`Execution profile snapshot ${pathLabel}.${tier}.control must be a string when present`);
    }
  }
}

function fail(message: string): never {
  throw new Error(message);
}

function trimCache(): void {
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== "string") {
      return;
    }
    cache.delete(oldestKey);
  }
}
