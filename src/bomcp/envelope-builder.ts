import { randomUUID } from "node:crypto";
import type { BomcpEnvelope, BomcpMessageKind, BomcpSender } from "./types.ts";

function generateMessageId(): string {
  return `msg_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export class EnvelopeBuilder {
  private sequence = 0;
  private readonly executionId: string;

  constructor(executionId: string) {
    this.executionId = executionId;
  }

  build<P>(input: {
    kind: BomcpMessageKind;
    sender: BomcpSender;
    payload: P;
    request_id?: string;
    reply_to?: string;
    correlation_id?: string;
  }): BomcpEnvelope<P> {
    return {
      message_id: generateMessageId(),
      execution_id: this.executionId,
      kind: input.kind,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      sender: input.sender,
      payload: input.payload,
      ...(input.request_id ? { request_id: input.request_id } : {}),
      ...(input.reply_to ? { reply_to: input.reply_to } : {}),
      ...(input.correlation_id ? { correlation_id: input.correlation_id } : {}),
    };
  }

  currentSequence(): number {
    return this.sequence;
  }
}

export const RUNTIME_SENDER: BomcpSender = { type: "runtime", id: "runtime" };

export function agentSender(agentId: string): BomcpSender {
  return { type: "agent", id: agentId };
}
