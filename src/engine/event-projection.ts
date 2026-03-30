import type { ControllerStream } from "../bomcp/controller-stream.ts";
import type { AdapterEvent } from "../adapters/types.ts";

/**
 * Pure event emitter: converts adapter events to BOMCP envelopes on the stream.
 * Does NOT read or write execution state — state capture is the collector's job.
 */
export async function projectAdapterEvent(input: {
  stream: ControllerStream;
  event: AdapterEvent;
  agentId: string;
}): Promise<void> {
  const { stream, event, agentId } = input;

  switch (event.type) {
    case "provider.started":
      // State capture (agent_id) handled by collector, not here.
      return;

    case "provider.progress":
      await stream.emitAgent(agentId, "progress.update", {
        phase: event.progress?.current_phase,
        detail: event.message,
      });
      return;

    case "provider.output.chunk":
      await stream.emitAgent(agentId, "progress.chunk", {
        text: event.text,
      });
      return;

    case "provider.turn_boundary":
    case "provider.debug":
    case "provider.completed":
    case "provider.failed":
      // Internal or terminal — not emitted to controller stream.
      return;

    default:
      return;
  }
}
