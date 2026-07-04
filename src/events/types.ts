export interface BomcpSender {
  type: "agent" | "runtime";
  id: string;
}

export type BomcpMessageKind =
  | "control.handoff"
  | "artifact.register"
  | "artifact.registered"
  | "artifact.registration_rejected"
  | "artifact.require"
  | "artifact.available"
  | "artifact.missing"
  | "progress.update"
  | "progress.heartbeat"
  | "progress.chunk"
  | "execution.started"
  | "execution.completed"
  | "execution.failed"
  | "execution.cancelled"
  | "system.error"
  | "system.lease_expired";

export interface BomcpEnvelope<P = unknown> {
  message_id: string;
  execution_id?: string;
  kind: BomcpMessageKind;
  sequence: number;
  timestamp: string;
  sender: BomcpSender;
  request_id?: string;
  correlation_id?: string;
  reply_to?: string;
  payload: P;
}
