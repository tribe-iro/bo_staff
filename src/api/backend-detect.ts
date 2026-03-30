import type { BackendName } from "../types/api.ts";
import { isExecutableOnPath } from "../utils.ts";

const BACKENDS: BackendName[] = ["claude", "codex"];

export async function autoSelectBackend(): Promise<{ backend: BackendName } | { error: string }> {
  const envDefault = process.env.BO_STAFF_DEFAULT_BACKEND;
  if (envDefault) {
    if (BACKENDS.includes(envDefault as BackendName)) {
      return { backend: envDefault as BackendName };
    }
    return { error: `BO_STAFF_DEFAULT_BACKEND '${envDefault}' is not a supported backend (${BACKENDS.join(", ")})` };
  }

  const available: BackendName[] = [];
  for (const b of BACKENDS) {
    if (await isExecutableOnPath(b)) {
      available.push(b);
    }
  }

  if (available.length === 0) {
    return { error: `no agent backend found on PATH (install ${BACKENDS.join(" or ")})` };
  }
  if (available.length === 1) {
    return { backend: available[0] };
  }
  // Both available — prefer claude
  return { backend: "claude" };
}

const DEFAULT_MODELS: Record<BackendName, string> = {
  claude: "claude-sonnet-4-6",
  codex: "gpt-5",
};

export function defaultModelForBackend(backend: BackendName): string {
  return DEFAULT_MODELS[backend] ?? "unknown";
}
