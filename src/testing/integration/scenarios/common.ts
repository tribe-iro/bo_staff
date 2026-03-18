import { randomUUID } from "node:crypto";
import path from "node:path";
import type { IntegrationContext } from "../fixtures.ts";
import type { ExecutionRequest } from "../../../types.ts";
import { asRecord } from "../../../utils.ts";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? Array<DeepPartial<U>>
    : T[K] extends ReadonlyArray<infer U>
      ? ReadonlyArray<DeepPartial<U>>
      : T[K] extends object
        ? DeepPartial<T[K]>
        : T[K];
};

export type IntegrationAgent = "codex" | "claude";

export function buildRequest(
  backend: IntegrationAgent,
  sourceRoot: string,
  prompt: string,
  overrides: DeepPartial<ExecutionRequest> = {}
): ExecutionRequest {
  const defaultFilesystem = backend === "claude" ? "workspace_write" : "read_only";
  const request: ExecutionRequest = {
    backend,
    execution_profile: {
      performance_tier: "balanced",
      reasoning_tier: "standard",
      selection_mode: "managed"
    },
    task: {
      prompt
    },
    session: {
      mode: "new"
    },
    workspace: {
      source_root: sourceRoot,
      writeback: "apply"
    },
    policy: {
      isolation: "default",
      approvals: "default",
      filesystem: defaultFilesystem
    },
    output: {
      format: "message",
      schema: {
        type: "object",
        required: ["content"],
        additionalProperties: false,
        properties: {
          content: { type: "string" }
        }
      }
    }
  };
  mergeDeep(request, overrides);
  return request;
}

export function project(context: IntegrationContext, name: string): string {
  return path.join(context.projectsDir, name);
}

export function uniqueMarker(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export async function runNamedScenario(
  context: IntegrationContext,
  name: string,
  run: () => Promise<void>
): Promise<void> {
  context.scenarioStats.planned += 1;
  if (context.scenarioFilter && !scenarioFilterMatches(name, context.scenarioFilter)) {
    context.scenarioStats.skipped += 1;
    console.log(`[it] skip ${name}`);
    return;
  }
  context.scenarioStats.executed += 1;
  console.log(`[it] run ${name}`);
  await run();
}

export async function runExplicitScenario(
  context: IntegrationContext,
  name: string,
  run: () => Promise<void>
): Promise<void> {
  if (!context.scenarioFilter || !scenarioFilterMatches(name, context.scenarioFilter)) {
    return;
  }
  await runNamedScenario(context, name, run);
}

function mergeDeep<T extends object>(target: T, source: DeepPartial<T>): T {
  const targetRecord = target as unknown as Record<string, unknown>;
  const sourceRecord = source as Record<string, unknown>;
  for (const [key, value] of Object.entries(sourceRecord)) {
    const sourceChild = asRecord(value);
    const targetChild = asRecord(targetRecord[key]);
    if (sourceChild && targetChild) {
      mergeDeep(targetChild, sourceChild);
      continue;
    }
    targetRecord[key] = value;
  }
  return target;
}

export function scenarioFilterMatches(name: string, filters: Set<string>): boolean {
  for (const filter of filters) {
    if (name === filter || name.includes(filter)) {
      return true;
    }
  }
  return false;
}
