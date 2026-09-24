// The bo standard as TypeScript types. Every shape is defined once, in `contract/schema.ts`; this module derives the
// types (and names the few derived ones) so code never restates a shape. No harness vocabulary lives here.

import type { Static } from "typebox";
import type * as S from "./contract/schema.ts";

export { ACCESS_LEVELS, DECISIONS, ENGINE_IDS, ERROR_CODES, IMAGE_MEDIA_TYPES, RUN_STATUSES } from "./contract/schema.ts";

export type EngineId = Static<typeof S.EngineId>;
export type Access = Static<typeof S.Access>;
export type ImageMediaType = Static<typeof S.ImageMediaType>;

export type Part = Static<typeof S.Part>;
/** A run result is text or structured data; images are input-only. */
export type ResultPart = Static<typeof S.ResultPart>;
export type McpServer = Static<typeof S.McpServer>;
export type Subagent = Static<typeof S.Subagent>;
export type RunSpec = Static<typeof S.RunSpec>;

export type Usage = Static<typeof S.Usage>;
export type Run = Static<typeof S.Run>;
export type RunStatus = Run["status"];
export type ErrorCode = NonNullable<Run["error"]>["code"];
export const TERMINAL: ReadonlySet<RunStatus> = new Set(["completed", "failed", "cancelled"]);

export type Action = Static<typeof S.Action>;
export type Question = Static<typeof S.Question>;
export type Item = Static<typeof S.Item>;

/** An item without the fields bo assigns (`id`, `parent_id`, `created_at`): what harnesses and translators produce. */
type Body<T> = T extends unknown ? Omit<T, "id" | "parent_id" | "created_at"> : never;
export type ItemBody = Body<Item>;
export type MessageItem = Body<Static<typeof S.MessageItem>>;
export type ActionItem = Body<Static<typeof S.ActionItem>>;
export type QuestionItem = Body<Static<typeof S.QuestionItem>>;
export type ActionStatus = ActionItem["status"];
export type AwaitableBody = (ActionItem & { status: "awaiting_approval" }) | (QuestionItem & { status: "awaiting_answer" });

/**
 * `allow_for_run` allows every later action of the same kind for the rest of the run; for `mcp`, the same server and
 * tool; for `other`, the same name.
 */
export type Decision = (typeof S.DECISIONS)[number];
/** An answer to an awaiting item: a decision (an action) or answers (a question). */
export type Response = { decision: Decision } | { answers: Record<string, string[]> };

export type Session = Static<typeof S.Session>;
export type SessionRun = Static<typeof S.SessionRun>;
export type ModelInfo = Static<typeof S.ModelInfo>;
export type EngineInfo = Static<typeof S.EngineInfo>;
export type AuthKind = EngineInfo["authentication"];
export type StreamEvent = Static<typeof S.StreamEvent>;
