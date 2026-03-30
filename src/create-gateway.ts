import { CodexAdapter } from "./adapters/codex/adapter.ts";
import { ClaudeAdapter } from "./adapters/claude/adapter.ts";
import { ExecutionManager } from "./engine/execution-manager.ts";
import { BoStaff } from "./gateway.ts";
import { DEFAULT_MAX_CONCURRENT_EXECUTIONS } from "./config/defaults.ts";

export interface CreateBoStaffOptions {
  dataDir: string;
  maxConcurrentExecutions?: number;
}

export async function createBoStaff(options: CreateBoStaffOptions): Promise<BoStaff> {
  const executionManager = new ExecutionManager({
    adapters: [new CodexAdapter(), new ClaudeAdapter()],
    dataDir: options.dataDir,
    maxConcurrentExecutions: options.maxConcurrentExecutions ?? DEFAULT_MAX_CONCURRENT_EXECUTIONS,
  });
  return new BoStaff({ executionManager });
}
