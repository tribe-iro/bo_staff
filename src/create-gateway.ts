import { CodexAdapter } from "./adapters/codex/adapter.ts";
import { ClaudeAdapter } from "./adapters/claude/adapter.ts";
import { ExecutionManager } from "./engine/execution-manager.ts";
import { BoStaff } from "./gateway.ts";
import { acquireDataDirLock } from "./persistence/data-dir-lock.ts";
import { WorkerThreadSqliteBoStaffRepository } from "./persistence/sqlite-worker-repository.ts";
import {
  DEFAULT_MAX_CONCURRENT_EXECUTIONS,
  DEFAULT_SESSIONLESS_EXECUTION_RETENTION_MS
} from "./config/defaults.ts";

export interface CreateBoStaffOptions {
  dataDir: string;
  profilesFile?: string;
  maxConcurrentExecutions?: number;
  sessionlessExecutionRetentionMs?: number;
}

export async function createBoStaff(options: CreateBoStaffOptions): Promise<BoStaff> {
  const dataDirLock = await acquireDataDirLock(options.dataDir);
  const repository = new WorkerThreadSqliteBoStaffRepository(options.dataDir);
  try {
    await repository.recoverInterruptedExecutions();
    await repository.pruneSessionlessTerminalExecutions(new Date(
      Date.now() - (options.sessionlessExecutionRetentionMs ?? DEFAULT_SESSIONLESS_EXECUTION_RETENTION_MS)
    ).toISOString());
    const executionManager = new ExecutionManager({
      adapters: [
        new CodexAdapter(),
        new ClaudeAdapter()
      ],
      repository,
      dataDir: options.dataDir,
      profilesFile: options.profilesFile,
      maxConcurrentExecutions: options.maxConcurrentExecutions ?? DEFAULT_MAX_CONCURRENT_EXECUTIONS,
      sessionlessExecutionRetentionMs: options.sessionlessExecutionRetentionMs ?? DEFAULT_SESSIONLESS_EXECUTION_RETENTION_MS
    });
    return new BoStaff({
      dataDir: options.dataDir,
      repository,
      executionManager,
      onShutdown: () => dataDirLock.release()
    });
  } catch (error) {
    await repository.close().catch(() => undefined);
    await dataDirLock.release().catch(() => undefined);
    throw error;
  }
}
