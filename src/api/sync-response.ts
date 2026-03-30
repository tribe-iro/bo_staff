import type { BomcpEnvelope } from "../bomcp/types.ts";
import { extractAgentContent } from "../bomcp/output.ts";
import { asRecord } from "../utils.ts";

export interface SyncRunResult {
  status: "completed" | "failed" | "cancelled";
  output?: string;
  artifacts: Array<{ kind: string; path: string; metadata?: Record<string, unknown> }>;
  continuation?: { backend: string; token: string };
  usage?: { input_tokens?: number; output_tokens?: number; duration_ms?: number };
  error?: { code: string; message: string };
  execution_id: string;
  _envelopes?: BomcpEnvelope[];  // only when verbose
}

export function buildSyncResult(envelopes: BomcpEnvelope[], opts?: { verbose?: boolean }): SyncRunResult {
  let status: SyncRunResult["status"] = "failed";
  let executionId = "";
  let output: string | undefined;
  let usage: SyncRunResult["usage"] | undefined;
  let continuation: SyncRunResult["continuation"] | undefined;
  let error: SyncRunResult["error"] | undefined;
  const artifacts: SyncRunResult["artifacts"] = [];
  const seenArtifacts = new Set<string>();

  for (const env of envelopes) {
    if (env.execution_id && !executionId) {
      executionId = env.execution_id;
    }

    const payload = asRecord(env.payload) ?? {};

    switch (env.kind) {
      case "execution.completed": {
        status = "completed";
        // Extract output from terminal envelope using canonical extractor
        output = extractAgentContent(env);
        // Extract usage
        if (payload.usage) {
          usage = payload.usage as SyncRunResult["usage"];
        }
        if (typeof payload.continuation === "object" && payload.continuation !== null) {
          const ref = asRecord(payload.continuation);
          if (typeof ref?.backend === "string" && typeof ref?.token === "string") {
            continuation = { backend: ref.backend, token: ref.token };
          }
        }
        // Extract artifacts from completed payload
        if (Array.isArray(payload.artifacts)) {
          for (const a of payload.artifacts) {
            const art = asRecord(a);
            if (art && typeof art.kind === "string") {
              pushArtifactUnique(artifacts, seenArtifacts, {
                kind: String(art.kind ?? ""),
                path: String(art.path ?? ""),
                metadata: asRecord(art.metadata) ?? undefined,
              });
            }
          }
        }
        break;
      }
      case "execution.failed": {
        status = "failed";
        error = {
          code: typeof payload.code === "string" ? payload.code : "execution_failed",
          message: typeof payload.message === "string" ? payload.message : "execution failed",
        };
        break;
      }
      case "execution.cancelled": {
        status = "cancelled";
        error = {
          code: "cancelled",
          message: typeof payload.reason === "string" ? payload.reason : "execution cancelled",
        };
        break;
      }
      case "system.error": {
        if (!error) {
          error = {
            code: typeof payload.code === "string" ? payload.code : "system_error",
            message: typeof payload.message === "string" ? payload.message : "system error",
          };
        }
        break;
      }
      case "artifact.registered": {
        if (typeof payload.kind === "string") {
          pushArtifactUnique(artifacts, seenArtifacts, {
            kind: String(payload.kind ?? ""),
            path: String(payload.path ?? ""),
            metadata: asRecord(payload.metadata) ?? undefined,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  const result: SyncRunResult = {
    status,
    output,
    artifacts,
    continuation,
    usage,
    error,
    execution_id: executionId,
  };

  if (opts?.verbose) {
    result._envelopes = envelopes;
  }

  return result;
}

function pushArtifactUnique(
  target: SyncRunResult["artifacts"],
  seen: Set<string>,
  artifact: SyncRunResult["artifacts"][number],
): void {
  const key = `${artifact.kind}\u0000${artifact.path}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  target.push(artifact);
}
