import type { BackendName } from "../types/api.ts";
import { CLI_AGENT_DESCRIPTORS, getCliAgentDescriptor } from "../adapters/descriptors.ts";
import { isExecutableOnPath } from "../utils.ts";

export async function autoSelectBackend(): Promise<{ backend: BackendName } | { error: string }> {
  const envDefault = process.env.BO_STAFF_DEFAULT_BACKEND;
  if (envDefault) {
    if (getCliAgentDescriptor(envDefault as BackendName)) {
      return { backend: envDefault as BackendName };
    }
    return {
      error: `BO_STAFF_DEFAULT_BACKEND '${envDefault}' is not a supported backend (${CLI_AGENT_DESCRIPTORS.map((descriptor) => descriptor.backend).join(", ")})`,
    };
  }

  const available: BackendName[] = [];
  for (const descriptor of [...CLI_AGENT_DESCRIPTORS].sort((left, right) => left.auto_select_rank - right.auto_select_rank)) {
    if (await isExecutableOnPath(descriptor.executable)) {
      available.push(descriptor.backend);
    }
  }

  if (available.length === 0) {
    return {
      error: `no agent backend found on PATH (install ${CLI_AGENT_DESCRIPTORS.map((descriptor) => descriptor.executable).join(" or ")})`,
    };
  }
  if (available.length === 1) {
    return { backend: available[0] };
  }
  return { backend: available[0] };
}

export function defaultModelForBackend(backend: BackendName): string {
  return getCliAgentDescriptor(backend)?.default_model ?? "unknown";
}
