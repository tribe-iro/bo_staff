import type { BackendName } from "../types.ts";
import type { BackendConformanceContract } from "./contracts.ts";
import { CLAUDE_CONFORMANCE } from "./providers/claude.ts";
import { CODEX_CONFORMANCE } from "./providers/codex.ts";

const MATRIX: Record<BackendName, BackendConformanceContract> = {
  codex: CODEX_CONFORMANCE,
  claude: CLAUDE_CONFORMANCE
};

export function getConformanceContract(backend: BackendName): BackendConformanceContract {
  return MATRIX[backend];
}

export function listConformanceContracts(): BackendConformanceContract[] {
  return Object.values(MATRIX);
}
