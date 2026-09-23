// Pure translation: codex app-server notifications → bo item ops. No I/O, no clocks.

import type { Action, ActionStatus, ErrorCode, ItemBody, Usage } from "../../model.ts";
import type { ResolvedSpec } from "../../spec.ts";
import { excerpt, tail } from "../common.ts";
import { failure, type Op, type Outcome } from "../port.ts";
import type {
  AgentMessageDelta, CommandAction, ErrorNotification, ItemNotification, ItemStatus, McpStartupStatus, PlanUpdated, ThreadItem,
  TokenUsageBreakdown, TokenUsageUpdated, Turn, TurnCompleted, TurnError,
} from "./protocol.ts";

const PLAN_STATUS = { pending: "pending", inProgress: "in_progress", completed: "completed" } as const;

const STATUS: Record<ItemStatus, ActionStatus> = {
  inProgress: "running", completed: "completed", failed: "failed", declined: "denied",
};

export interface CodexTranslator {
  onNotification(method: string, params: unknown): Op[];
  setMainThread(id: string): void;
  parentOf(threadId: string): string | undefined;
  actionOf(itemId: string): Action | undefined;
  readonly turn: Turn | undefined;
  outcome(): Outcome;
}

export function actionFor(item: ThreadItem): { action: Action; status: ActionStatus } | undefined {
  const status = "status" in item && typeof item.status === "string" ? STATUS[item.status as ItemStatus] ?? "running" : "running";
  switch (item.type) {
    case "commandExecution": {
      const i = item as Extract<ThreadItem, { type: "commandExecution" }>;
      return { action: commandAction(i.command, i.commandActions ?? []), status };
    }
    case "fileChange": {
      const i = item as Extract<ThreadItem, { type: "fileChange" }>;
      return {
        action: {
          kind: "edit",
          changes: i.changes.map((c) => ({ path: c.path, change: c.kind.type === "add" ? "add" : c.kind.type === "delete" ? "delete" : "modify" })),
        },
        status,
      };
    }
    case "mcpToolCall": {
      const i = item as Extract<ThreadItem, { type: "mcpToolCall" }>;
      return { action: { kind: "mcp", server: i.server, tool: i.tool }, status };
    }
    case "webSearch": {
      const i = item as Extract<ThreadItem, { type: "webSearch" }>;
      return { action: i.action?.type === "openPage" && i.action.url ? { kind: "web", url: i.action.url } : { kind: "web", query: i.query }, status };
    }
    case "imageView": {
      const i = item as Extract<ThreadItem, { type: "imageView" }>;
      return { action: { kind: "read", paths: [i.path] }, status };
    }
    case "collabAgentToolCall": {
      const i = item as Extract<ThreadItem, { type: "collabAgentToolCall" }>;
      return { action: { kind: "delegate", task: tail(i.prompt ?? "", 200) }, status };
    }
  }
  return undefined;
}

/**
 * Codex runs file reads and searches as shell commands and classifies them; a command that is only reads, or one
 * search, is reported as the neutral `read`/`search` action Claude's Read/Grep/Glob produce.
 */
function commandAction(command: string, parsed: readonly CommandAction[]): Action {
  if (parsed.length && parsed.every((a) => a.type === "read")) {
    return { kind: "read", paths: parsed.map((a) => (a as Extract<CommandAction, { type: "read" }>).path) };
  }
  const only = parsed.length === 1 ? parsed[0] : undefined;
  if (only?.type === "search") return { kind: "search", query: only.query ?? only.path ?? command };
  if (only?.type === "listFiles") return { kind: "search", query: only.path ?? command };
  return { kind: "shell", command };
}

export function createTranslator(spec: Pick<ResolvedSpec, "schema">): CodexTranslator {
  let mainThread = "";
  const children = new Map<string, string>();  // child threadId → collab item id
  const actions = new Map<string, Action>();
  let lastAgentText: string | undefined;
  let finalAnswer: string | undefined;
  let total: TokenUsageBreakdown | undefined;
  let turn: Turn | undefined;
  let error: TurnError | undefined;
  let notices = 0;

  const notice = (level: "info" | "warning", text: string): Op =>
    ({ op: "upsert", key: `notice:${++notices}`, body: { type: "notice", level, text } });

  const parentOf = (threadId: string): string | undefined => (threadId && threadId !== mainThread ? children.get(threadId) : undefined);

  const onItem = (p: ItemNotification, completed: boolean): Op[] => {
    const { item, threadId } = p;
    const parentKey = parentOf(threadId);
    if (item.type === "agentMessage") {
      const message = item as Extract<ThreadItem, { type: "agentMessage" }>;
      const text = completed ? message.text : "";
      if (completed && threadId === mainThread) {
        lastAgentText = text;
        if (message.phase === "final_answer") finalAnswer = text;
      }
      return [{
        op: "upsert", key: item.id, parentKey,
        body: { type: "message", role: "agent", content: [{ kind: "text", text }], status: completed ? "completed" : "in_progress" },
      }];
    }
    if (item.type === "reasoning") {
      if (!completed) return [];
      const r = item as Extract<ThreadItem, { type: "reasoning" }>;
      const text = (r.summary?.length ? r.summary : r.content ?? []).join("\n\n").trim();
      return text ? [{ op: "upsert", key: item.id, parentKey, body: { type: "reasoning", text } }] : [];
    }
    if (item.type === "contextCompaction") return completed ? [notice("info", "context compacted")] : [];
    if (item.type === "collabAgentToolCall") {
      for (const tid of (item as Extract<ThreadItem, { type: "collabAgentToolCall" }>).receiverThreadIds ?? []) children.set(tid, item.id);
    }
    const mapped = actionFor(item);
    if (!mapped) return [];
    actions.set(item.id, mapped.action);
    const status = !completed && mapped.status !== "denied" ? "running" : completed && mapped.status === "running" ? "completed" : mapped.status;
    const body: ItemBody = { type: "action", action: mapped.action, status };
    if (item.type === "commandExecution") {
      const c = item as Extract<ThreadItem, { type: "commandExecution" }>;
      if (completed) body.outcome = { ...(typeof c.exitCode === "number" ? { exit_code: c.exitCode } : {}), excerpt: excerpt(c.aggregatedOutput ?? "") };
    }
    return [{ op: "upsert", key: item.id, parentKey, body }];
  };

  return {
    get turn() { return turn; },
    setMainThread(id) { mainThread = id; },
    parentOf,
    actionOf: (itemId) => actions.get(itemId),
    onNotification(method, params) {
      switch (method) {
        case "item/started": return onItem(params as ItemNotification, false);
        case "item/completed": return onItem(params as ItemNotification, true);
        case "item/agentMessage/delta": {
          const d = params as AgentMessageDelta;
          return [{ op: "delta", key: d.itemId, text: d.delta }];
        }
        case "thread/tokenUsage/updated": {
          const u = params as TokenUsageUpdated;
          const main = !mainThread || u.threadId === mainThread;
          if (main) total = u.tokenUsage.total;
          const last = u.tokenUsage.last;
          return last ? [{ op: "call", tokens: last.inputTokens + last.outputTokens, main }] : [];
        }
        case "turn/plan/updated": {
          const p = params as PlanUpdated;
          if (p.threadId !== mainThread) return [];
          return [{ op: "upsert", key: "plan", body: { type: "plan", steps: p.plan.map((s) => ({ text: s.step, status: PLAN_STATUS[s.status] })) } }];
        }
        case "mcpServer/startupStatus/updated": {
          const m = params as McpStartupStatus;
          return m.status === "failed" ? [notice("warning", `MCP server ${m.name} failed to start${m.error ? `: ${m.error}` : ""}`)] : [];
        }
        case "error": {
          const e = params as ErrorNotification;
          if (e.willRetry) return [notice("warning", e.error.message)];
          error = e.error;
          return [];
        }
        case "turn/completed": {
          const t = params as TurnCompleted;
          if (!mainThread || t.threadId === mainThread) turn = t.turn;
          return [];
        }
      }
      return [];
    },
    outcome() {
      const usage = usageOf(total);
      const answer = finalAnswer ?? lastAgentText;
      if (turn?.status === "completed" && answer !== undefined) {
        if (!spec.schema) return { ok: true, result: { kind: "text", text: answer }, usage };
        try {
          const data: unknown = JSON.parse(answer);
          if (typeof data === "object" && data !== null && !Array.isArray(data)) return { ok: true, result: { kind: "data", data }, usage };
        } catch {
          // fall through
        }
        return failure("invalid_output", "final message is not a JSON object", usage, { finalMessage: answer });
      }
      if (turn?.status === "completed") return failure("engine_error", "no final message", usage);
      const err = turn?.error ?? error;
      const code = errorCode(err);
      const message = turn?.status === "interrupted" ? "Codex turn was interrupted" : publicMessage(code);
      return failure(code, message, usage, err);
    },
  };
}

function publicMessage(code: ErrorCode): string {
  switch (code) {
    case "auth_failed": return "Codex authentication failed";
    case "rate_limited": return "Codex rate limit exceeded";
    case "context_exceeded": return "Codex context window exceeded";
    default: return "Codex execution failed";
  }
}

function errorCode(err: TurnError | undefined): ErrorCode {
  const info = err?.codexErrorInfo;
  const tag = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : undefined;
  switch (tag) {
    case "unauthorized": return "auth_failed";
    case "rateLimitExceeded":
    case "usageLimitExceeded":
    case "serverOverloaded": return "rate_limited";
    case "contextWindowExceeded": return "context_exceeded";
    default: return "engine_error";
  }
}

/** Thread totals. OpenAI semantics already match bo's: input includes cached tokens, output includes reasoning. */
function usageOf(t: TokenUsageBreakdown | undefined): Usage {
  if (!t) return { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };
  return { input_tokens: t.inputTokens, output_tokens: t.outputTokens, cached_input_tokens: t.cachedInputTokens };
}
