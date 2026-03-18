import type { BoStaffEvent, BoStaffEventName } from "../types.ts";
import { nowIso } from "../utils.ts";

export class EventLog {
  private readonly events: BoStaffEvent[] = [];
  private readonly requestId: string;
  private readonly executionId: string;
  private readonly onAppend?: (event: BoStaffEvent) => Promise<void> | void;

  constructor(
    requestId: string,
    executionId: string,
    onAppend?: (event: BoStaffEvent) => Promise<void> | void
  ) {
    this.requestId = requestId;
    this.executionId = executionId;
    this.onAppend = onAppend;
  }

  build<T extends Record<string, unknown>>(event: BoStaffEventName, data: T): BoStaffEvent<T> {
    return {
      event,
      request_id: this.requestId,
      execution_id: this.executionId,
      emitted_at: nowIso(),
      data
    };
  }

  async append<T extends Record<string, unknown>>(event: BoStaffEventName, data: T): Promise<BoStaffEvent<T>> {
    const entry = this.build(event, data);
    await this.record(entry);
    return entry;
  }

  async record(entry: BoStaffEvent): Promise<void> {
    this.events.push(entry);
    await this.onAppend?.(entry);
  }

  list(): BoStaffEvent[] {
    return this.events.slice();
  }
}
