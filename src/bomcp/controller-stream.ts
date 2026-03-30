import type { BomcpEnvelope, BomcpMessageKind, BomcpSender } from "./types.ts";
import { EnvelopeBuilder, RUNTIME_SENDER } from "./envelope-builder.ts";

export type StreamWriter = (envelope: BomcpEnvelope) => Promise<void>;
export interface StreamEmission<P> {
  envelope: BomcpEnvelope<P>;
  delivered: boolean;
}

export class ControllerStream {
  private closed = false;
  private readonly writer: StreamWriter;
  private readonly envelopeBuilder: EnvelopeBuilder;

  constructor(writer: StreamWriter, envelopeBuilder: EnvelopeBuilder) {
    this.writer = writer;
    this.envelopeBuilder = envelopeBuilder;
  }

  async emit<P>(input: {
    kind: BomcpMessageKind;
    sender: BomcpSender;
    payload: P;
    request_id?: string;
    reply_to?: string;
    correlation_id?: string;
  }): Promise<StreamEmission<P>> {
    if (this.closed) {
      return {
        envelope: this.envelopeBuilder.build(input),
        delivered: false,
      };
    }
    const envelope = this.envelopeBuilder.build(input);
    await this.writer(envelope);
    return { envelope, delivered: true };
  }

  async emitRuntime<P>(
    kind: BomcpMessageKind,
    payload: P,
    opts?: { reply_to?: string; request_id?: string },
  ): Promise<StreamEmission<P>> {
    return this.emit({
      kind,
      sender: RUNTIME_SENDER,
      payload,
      ...opts,
    });
  }

  async emitAgent<P>(
    agentId: string,
    kind: BomcpMessageKind,
    payload: P,
    opts?: { request_id?: string },
  ): Promise<StreamEmission<P>> {
    return this.emit({
      kind,
      sender: { type: "agent", id: agentId },
      payload,
      ...opts,
    });
  }

  close(): void {
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  currentSequence(): number {
    return this.envelopeBuilder.currentSequence();
  }
}
