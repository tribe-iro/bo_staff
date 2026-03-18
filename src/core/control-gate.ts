export const CONTROL_GATE_POLICY_CLASSES = [
  "interactive",
  "filesystem",
  "network",
  "tooling"
] as const;

export type ControlGatePolicyClass = (typeof CONTROL_GATE_POLICY_CLASSES)[number];
export type ControlGateMode = "disabled" | "on_request" | "required";
export type ControlGateStatus = "pending" | "approved" | "denied";

export interface ControlGateRecord {
  control_gate_id: string;
  policy_class: ControlGatePolicyClass;
  kind: string;
  status: ControlGateStatus;
  reason: string;
  requested_at: string;
  resolved_at?: string;
}
