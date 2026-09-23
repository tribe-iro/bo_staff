import type { Engines } from "../core/engines.ts";
import type { RunManager } from "../core/runs.ts";
import type { SessionIndex } from "../core/sessions.ts";
import type { Problem } from "../problems.ts";

/** Everything a request handler (/v1 or A2A) may use. */
export interface Context {
  runs: RunManager;
  engines: Engines;
  sessions: SessionIndex;
  /** Open streaming responses; shutdown waits for them to flush their terminal event. */
  streams: Set<Promise<void>>;
}

export type Body = { raw: unknown } | { problem: Problem };
