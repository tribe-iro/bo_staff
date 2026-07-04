import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { getCliAgentDescriptor } from "../../src/adapters/descriptors.ts";
import { ExecutionManager } from "../../src/engine/execution-manager.ts";
import { BoStaff } from "../../src/gateway.ts";
import type { AdapterEvent, CliAgentAdapter } from "../../src/adapters/types.ts";
import type { ArtifactRecord, BackendName, ExecutionError, UsageSummary } from "../../src/types.ts";

interface FakeCompactOutput {
  summary: string;
  payload: unknown;
  pending_items: string[];
  artifacts?: ArtifactRecord[];
}

interface FakeAdapterResult {
  continuation?: { backend: BackendName; token: string };
  compact_output?: FakeCompactOutput;
  usage?: UsageSummary;
  errors?: ExecutionError[];
  debug?: Record<string, unknown>;
}

export class FakeAdapter implements CliAgentAdapter {
  readonly backend: BackendName;
  readonly capabilities;
  private readonly factory: (input: Parameters<CliAgentAdapter["execute"]>[0]) => Promise<FakeAdapterResult> | FakeAdapterResult;

  constructor(
    backend: BackendName,
    factory: (input: Parameters<CliAgentAdapter["execute"]>[0]) => Promise<FakeAdapterResult> | FakeAdapterResult
  ) {
    this.backend = backend;
    const descriptor = getCliAgentDescriptor(backend);
    if (!descriptor) {
      throw new Error(`missing CLI agent descriptor for ${backend}`);
    }
    this.capabilities = descriptor.capabilities;
    this.factory = factory;
  }

  async *execute(input: Parameters<CliAgentAdapter["execute"]>[0]): AsyncIterable<AdapterEvent> {
    const result = await this.factory(input);
    yield { type: "provider.started", provider_session_id: result.continuation?.token };
    yield { type: "provider.progress", message: `fake-${this.backend}-progress` };
    if (result.debug) {
      yield { type: "provider.debug", debug: result.debug };
    }
    if (result.errors?.length) {
      const messages = result.errors.map((error) => error.message).join("; ");
      yield {
        type: "provider.failed",
        error: {
          command: `fake-${this.backend}`,
          reason: "exited",
          exit_code: 1,
          stdout: "",
          stderr: messages,
        }
      };
      return;
    }

    const compactOutput = result.compact_output ?? {
      summary: "",
      payload: {},
      pending_items: [],
      artifacts: []
    };
    const serialized = JSON.stringify({
      summary: compactOutput.summary,
      payload: compactOutput.payload,
      pending_items: compactOutput.pending_items,
      artifacts: compactOutput.artifacts ?? []
    });
    yield { type: "provider.output.chunk", text: serialized };
    for (const artifact of compactOutput.artifacts ?? []) {
      yield { type: "provider.artifact.upsert", artifact };
    }
    yield {
      type: "provider.completed",
      result: {
        continuation: result.continuation,
        raw_output_text: serialized,
        usage: result.usage,
        exit_reason: "completed",
        debug: result.debug
      }
    };
  }
}

export async function createTestGateway(input?: {
  adapters?: CliAgentAdapter[];
}): Promise<{ gateway: BoStaff; dataDir: string; cleanup: () => Promise<void> }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "bo-staff-test-"));
  const workspaceRoot = path.join(dataDir, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const executionManager = new ExecutionManager({
    adapters: input?.adapters ?? [],
    dataDir
  });
  return {
    gateway: new BoStaff({
      executionManager
    }),
    dataDir,
    cleanup: async () => {
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}
