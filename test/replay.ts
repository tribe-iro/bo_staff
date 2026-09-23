// Replays a recorded native transcript through the matching pure translator. Shared by the conformance
// runner (to write goldens) and the transcript tests (to compare against them).

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createTranslator as claudeTranslator } from "../src/harness/claude-code/translate.ts";
import { createTranslator as codexTranslator } from "../src/harness/codex/translate.ts";
import type { Op, Outcome } from "../src/harness/port.ts";
import type { EngineId } from "../src/model.ts";

type Obj = Record<string, unknown>;

export function replayTranscript(engine: EngineId, jsonl: string, spec: { schema?: Record<string, unknown> }): { ops: Op[]; outcome: Outcome } {
  const entries = jsonl.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Obj);
  const ops: Op[] = [];
  if (engine === "claude-code") {
    const t = claudeTranslator(spec);
    for (const e of entries) if (e.message) ops.push(...t.onMessage(e.message as SDKMessage));
    return { ops, outcome: t.outcome() };
  }
  const t = codexTranslator(spec);
  for (const e of entries) {
    if (typeof e.threadId === "string") t.setMainThread(e.threadId);
    if (typeof e.method === "string") ops.push(...t.onNotification(e.method, e.params ?? {}));
  }
  return { ops, outcome: t.outcome() };
}
