import path from "node:path";
import { mkdir, rmdir } from "node:fs/promises";
import { resolveWorkspaceScopeRoot } from "../workspace/scope.ts";
import type {
  NormalizedExecutionRequest,
  WorkspaceScopeStatus
} from "../types.ts";
import { generateHandle, nowIso, removeDir } from "../utils.ts";

interface WorkspaceRuntimeBase {
  topology: "direct";
  source_root: string | null;
  runtime_working_directory: string;
  run_dir: string;
  scope_status: WorkspaceScopeStatus;
}

export interface DirectWorkspaceRuntime extends WorkspaceRuntimeBase {
  topology: "direct";
}

export type WorkspaceRuntime = DirectWorkspaceRuntime;

export class WorkspaceManager {
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async prepare(input: {
    request: NormalizedExecutionRequest;
    runtimeHandle: string;
  }): Promise<WorkspaceRuntime> {
    const runDir = path.join(
      this.dataDir,
      "runs",
      input.runtimeHandle,
      `${nowIso().replaceAll(":", "-")}-${generateHandle("run").slice(4, 12)}`
    );
    await mkdir(runDir, { recursive: true });

    if (input.request.workspace.kind === "ephemeral") {
      const runtimeWorkingDirectory = path.join(runDir, "workspace");
      await mkdir(runtimeWorkingDirectory, { recursive: true });
      return {
        topology: "direct",
        source_root: null,
        runtime_working_directory: runtimeWorkingDirectory,
        run_dir: runDir,
        scope_status: "unbounded"
      };
    }

    const authorityRoot = resolveWorkspaceScopeRoot(input.request.workspace);
    return {
      topology: "direct",
      source_root: input.request.workspace.source_root,
      runtime_working_directory: authorityRoot,
      run_dir: runDir,
      scope_status: input.request.workspace.scope.mode === "subpath" ? "enforced" : "unbounded"
    };
  }

  async cleanup(runtime: WorkspaceRuntime): Promise<void> {
    await removeDir(runtime.run_dir);
    await removeEmptyRunParent(path.dirname(runtime.run_dir));
  }
}

async function removeEmptyRunParent(runParentDir: string): Promise<void> {
  try {
    await rmdir(runParentDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") {
      throw error;
    }
  }
}
