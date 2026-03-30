import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { ExecutionManager } from "../../src/engine/execution-manager.ts";
import { BoStaff } from "../../src/gateway.ts";
import type { AdapterEvent, BackendAdapter } from "../../src/adapters/types.ts";
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

export class FakeAdapter implements BackendAdapter {
  readonly backend: BackendName;
  private readonly factory: (input: Parameters<BackendAdapter["execute"]>[0]) => Promise<FakeAdapterResult> | FakeAdapterResult;

  constructor(
    backend: BackendName,
    factory: (input: Parameters<BackendAdapter["execute"]>[0]) => Promise<FakeAdapterResult> | FakeAdapterResult
  ) {
    this.backend = backend;
    this.factory = factory;
  }

  async *execute(input: Parameters<BackendAdapter["execute"]>[0]): AsyncIterable<AdapterEvent> {
    const result = await this.factory(input);
    yield { type: "provider.started", provider_session_id: result.continuation?.token };
    yield { type: "provider.progress", message: `fake-${this.backend}-progress` };
    if (result.debug) {
      yield { type: "provider.debug", debug: result.debug };
    }
    if (result.errors?.length) {
      yield {
        type: "provider.failed",
        error: {
          message: result.errors.map((error) => error.message).join("; "),
          retryable: result.errors.some((error) => error.retryable),
          kind: result.errors[0]?.code,
          debug: result.debug
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
  adapters?: BackendAdapter[];
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
