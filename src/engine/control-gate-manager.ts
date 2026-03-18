import type { ControlGateRecord } from "../types.ts";

export function partitionControlGates(records: ControlGateRecord[]): {
  pending: ControlGateRecord[];
  resolved: ControlGateRecord[];
} {
  return {
    pending: records.filter((record) => record.status === "pending"),
    resolved: records.filter((record) => record.status !== "pending")
  };
}
