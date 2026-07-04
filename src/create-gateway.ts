import { createSupportedCliAgentAdapters } from "./adapters/supported.ts";
import { ExecutionManager } from "./engine/execution-manager.ts";
import { BoStaff } from "./gateway.ts";
import { DEFAULT_MAX_CONCURRENT_EXECUTIONS } from "./config/defaults.ts";

export interface CreateBoStaffOptions {
  dataDir: string;
  maxConcurrentExecutions?: number;
}

export async function createBoStaff(options: CreateBoStaffOptions): Promise<BoStaff> {
  const executionManager = new ExecutionManager({
    adapters: createSupportedCliAgentAdapters(),
    dataDir: options.dataDir,
    maxConcurrentExecutions: options.maxConcurrentExecutions ?? DEFAULT_MAX_CONCURRENT_EXECUTIONS,
  });
  return new BoStaff({ executionManager });
}
