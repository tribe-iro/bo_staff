import type { BomcpEnvelope } from "../events/types.ts";
import { nowIso } from "../utils.ts";

export function buildRuntimeErrorEnvelope(
  payload: { code: string; message: string; issues?: unknown },
  opts?: { message_id?: string; sequence?: number },
): BomcpEnvelope {
  return {
    message_id: opts?.message_id ?? `err_${Date.now()}`,
    kind: "system.error",
    sequence: opts?.sequence ?? 0,
    timestamp: nowIso(),
    sender: { type: "runtime", id: "runtime" },
    payload: {
      code: payload.code,
      message: payload.message,
      ...(payload.issues !== undefined ? { issues: payload.issues } : {}),
    },
  };
}
