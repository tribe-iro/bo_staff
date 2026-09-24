// Pure translation: Claude Agent SDK messages → bo item ops. No I/O, no clocks.

import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Action, ErrorCode, ItemBody, Part, Usage } from "../../model.ts";
import type { ResolvedSpec } from "../../spec.ts";
import { excerpt } from "../common.ts";
import { addHunk, capDiff, patchHunks, replaceHunk, type PatchHunk } from "../../format.ts";
import { failure, usageSince, ZERO_USAGE, type Op, type Outcome } from "../port.ts";

type Obj = Record<string, unknown>;

/** Tools whose calls become something other than an `action` item. */
export const QUESTION_TOOL = "AskUserQuestion";
const PLAN_TOOL = "TodoWrite";
/** Task-tracking tools (Claude Code ≥ 2.1.268). Opted in via allowedTools; folded into one `plan` item. */
export const TASK_TOOLS = ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"] as const;
const TASK_TOOL_SET: ReadonlySet<string> = new Set(TASK_TOOLS);
type StepStatus = "pending" | "in_progress" | "completed";

export function toAction(name: string, input: Obj): Action {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  switch (name) {
    case "Bash": return { kind: "shell", command: s("command") };
    case "Read": return { kind: "read", paths: [s("file_path")] };
    // Before the tool runs, the diff is the requested replacement (line numbers unknown); the result has the real one.
    case "Edit": return edit(s("file_path"), "modify", typeof input.old_string === "string" ? replaceHunk(s("old_string"), s("new_string")) : "");
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? (input.edits as Obj[]) : [];
      return edit(s("file_path"), "modify", edits.map((e) => replaceHunk(String(e.old_string ?? ""), String(e.new_string ?? ""))).join(""));
    }
    case "NotebookEdit": return edit(s("notebook_path"), "modify", "");
    case "Write": return edit(s("file_path"), "add", addHunk(s("content")));
    case "Grep":
    case "Glob": return { kind: "search", query: s("pattern") };
    case "WebFetch": return { kind: "web", url: s("url") };
    case "WebSearch": return { kind: "web", query: s("query") };
    case "Agent":
    case "Task": return { kind: "delegate", ...(s("subagent_type") ? { subagent: s("subagent_type") } : {}), task: s("description") || s("prompt") };
    case "Skill": return { kind: "skill", name: s("skill") };
  }
  if (name.startsWith("mcp__")) {
    const rest = name.slice(5);
    const sep = rest.indexOf("__");
    if (sep > 0) return { kind: "mcp", server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
  }
  return { kind: "other", name };
}

const PLAN_STATUS: Record<string, "pending" | "in_progress" | "completed"> = {
  pending: "pending", in_progress: "in_progress", completed: "completed",
};

export interface ClaudeTranslator {
  onMessage(m: SDKMessage): Op[];
  /** Keys decided by policy (denied without asking); tool results must not overwrite them. */
  readonly denied: Set<string>;
  /**
   * A backgrounded subagent is still running: its result comes back as another turn, so the session must stay open.
   * Background shells do not count; they end with the run.
   */
  readonly busy: boolean;
  outcome(): Outcome;
}

export function createTranslator(spec: Pick<ResolvedSpec, "schema" | "session">): ClaudeTranslator {
  const actions = new Map<string, Action>();
  const denied = new Set<string>();
  const blockCount = new Map<string, number>();   // message.id → blocks seen (aligns with stream indices)
  const streamKeys = new Map<number, string>();  // content_block index → item key (main thread only)
  // Text streamed for a block before any visible character: the item is only opened once text is non-blank, so a
  // whitespace-only block (which the final assistant message skips) never leaves an `in_progress` item behind.
  const unopened = new Map<string, string>();
  let streamMessageId = "";
  let last: SDKResultMessage | undefined;
  let assistantError: string | undefined;
  let background = 0;   // live background subagents
  const callInput = new Map<string, number>();  // stream (main "" or parent tool use) → input tokens of its open call
  let notices = 0;
  const tasks = new Map<string, { text: string; status: StepStatus }>();  // task id → step, in creation order
  const pendingCreates = new Map<string, string>();                        // tool_use id → subject
  const planOp = (): Op => ({ op: "upsert", key: "plan", body: { type: "plan", steps: [...tasks.values()].map((t) => ({ ...t })) } });

  const nextBlockKey = (messageId: string): string => {
    const n = blockCount.get(messageId) ?? 0;
    blockCount.set(messageId, n + 1);
    return `${messageId}:${n}`;
  };

  const notice = (level: "info" | "warning", text: string): Op =>
    ({ op: "upsert", key: `notice:${++notices}`, body: { type: "notice", level, text } });

  return {
    denied,
    get busy() { return background > 0; },
    onMessage(m) {
      const ops: Op[] = [];
      switch (m.type) {
        case "system": {
          if (m.subtype === "init") {
            ops.push({ op: "session", native: m.session_id }, { op: "model", id: m.model });
            for (const server of m.mcp_servers ?? []) if (server.status === "failed") ops.push(notice("warning", `MCP server ${server.name} failed to start`));
          } else if (m.subtype === "compact_boundary") {
            ops.push(notice("info", "context compacted"));
          } else if (m.subtype === "background_tasks_changed") {
            background = (m.tasks ?? []).filter((t) => t.task_type === "local_agent" && !t.ambient).length;
          } else if (m.subtype === "task_notification" && !m.ambient) {
            // A background subagent's tokens are only known when it ends (its model calls are not streamed).
            if (m.usage?.total_tokens) ops.push({ op: "call", tokens: m.usage.total_tokens, main: false });
            const action = m.tool_use_id ? actions.get(m.tool_use_id) : undefined;
            if (m.tool_use_id && action && !denied.has(m.tool_use_id)) {
              ops.push({ op: "upsert", key: m.tool_use_id, body: {
                type: "action", action, status: m.status === "completed" ? "completed" : "failed", outcome: { excerpt: excerpt(m.summary) },
              } });
            }
          } else if (m.subtype === "api_retry") {
            ops.push({
              op: "upsert", key: `notice:retry:${m.attempt}`,
              body: { type: "notice", level: "warning", text: `API retry ${m.attempt}/${m.max_retries} in ${Math.round(m.retry_delay_ms / 1000)}s` },
            });
          }
          break;
        }
        case "stream_event": {
          const ev = m.event as unknown as Obj;
          // Every model call, main or subagent: input tokens (cached included) at its start, output at its end.
          const stream = m.parent_tool_use_id ?? "";
          if (ev.type === "message_start") {
            const u = ((ev.message as Obj | undefined)?.usage ?? {}) as Obj;
            callInput.set(stream, num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens));
          } else if (ev.type === "message_delta" && ev.usage && callInput.has(stream)) {
            ops.push({ op: "call", tokens: callInput.get(stream)! + num((ev.usage as Obj).output_tokens), main: !m.parent_tool_use_id });
            callInput.delete(stream);
          }
          if (m.parent_tool_use_id) break;
          if (ev.type === "message_start") {
            streamMessageId = String((ev.message as Obj | undefined)?.id ?? "");
            streamKeys.clear();
            unopened.clear();
          } else if (ev.type === "content_block_start" && (ev.content_block as Obj | undefined)?.type === "text") {
            const key = `${streamMessageId}:${ev.index as number}`;
            streamKeys.set(ev.index as number, key);
            unopened.set(key, "");
          } else if (ev.type === "content_block_delta" && (ev.delta as Obj | undefined)?.type === "text_delta") {
            const key = streamKeys.get(ev.index as number);
            if (!key) break;
            const text = String((ev.delta as Obj).text ?? "");
            const pending = unopened.get(key);
            if (pending === undefined) { ops.push({ op: "delta", key, text }); break; }
            const buffered = pending + text;
            if (!buffered.trim()) { unopened.set(key, buffered); break; }
            unopened.delete(key);
            ops.push({ op: "upsert", key, body: agentMessage("", "in_progress") }, { op: "delta", key, text: buffered });
          }
          break;
        }
        case "assistant": {
          if (m.error) assistantError = m.error;
          const parentKey = m.parent_tool_use_id ?? undefined;
          const msg = m.message as unknown as { id: string; content: Obj[] };
          for (const block of msg.content ?? []) {
            const key = nextBlockKey(msg.id);
            if (block.type === "text") {
              const text = String(block.text ?? "");
              if (text.trim()) ops.push({ op: "upsert", key, body: agentMessage(text, "completed"), parentKey });
            } else if (block.type === "thinking") {
              const text = String(block.thinking ?? "");
              if (text.trim()) ops.push({ op: "upsert", key, body: { type: "reasoning", text }, parentKey });
            } else if (block.type === "tool_use") {
              const name = String(block.name);
              const input = (block.input ?? {}) as Obj;
              const id = String(block.id);
              if (name === QUESTION_TOOL) continue;
              if (TASK_TOOL_SET.has(name)) {
                if (name === "TaskCreate") pendingCreates.set(id, String(input.subject ?? input.description ?? ""));
                if (name === "TaskUpdate" && typeof input.taskId === "string") {
                  const task = tasks.get(input.taskId);
                  if (input.status === "deleted") tasks.delete(input.taskId);
                  else if (task) {
                    if (typeof input.subject === "string") task.text = input.subject;
                    if (typeof input.status === "string" && input.status in PLAN_STATUS) task.status = PLAN_STATUS[input.status]!;
                  }
                  ops.push(planOp());
                }
                continue;
              }
              if (name === PLAN_TOOL) {
                const todos = Array.isArray(input.todos) ? (input.todos as Obj[]) : [];
                ops.push({
                  op: "upsert", key: "plan",
                  body: { type: "plan", steps: todos.map((t) => ({ text: String(t.content ?? ""), status: PLAN_STATUS[String(t.status)] ?? "pending" })) },
                });
                continue;
              }
              const action = toAction(name, input);
              actions.set(id, action);
              if (!denied.has(id)) ops.push({ op: "upsert", key: id, body: { type: "action", action, status: "running" }, parentKey });
            }
          }
          break;
        }
        case "user": {
          const content = (m.message as { content?: unknown }).content;
          if (!Array.isArray(content)) break;
          for (const block of content as Obj[]) {
            if (block.type !== "tool_result") continue;
            const id = String(block.tool_use_id);
            const subject = pendingCreates.get(id);
            if (subject !== undefined) {
              pendingCreates.delete(id);
              const created = ((m as { tool_use_result?: { task?: { id?: unknown; subject?: unknown } } }).tool_use_result)?.task;
              if (!block.is_error && created && typeof created.id === "string") {
                tasks.set(created.id, { text: typeof created.subject === "string" ? created.subject : subject, status: "pending" });
                ops.push(planOp());
              }
              continue;
            }
            const action = actions.get(id);
            // A foreground subagent's tokens arrive with its result (its model calls are not streamed).
            const subagentTokens = (m as { tool_use_result?: { totalTokens?: unknown } }).tool_use_result?.totalTokens;
            if (action?.kind === "delegate" && typeof subagentTokens === "number") ops.push({ op: "call", tokens: subagentTokens, main: false });
            if (!action || denied.has(id)) continue;
            const done = block.is_error ? action : withResultDiff(action, (m as { tool_use_result?: unknown }).tool_use_result);
            actions.set(id, done);
            const body: ItemBody = {
              type: "action", action: done,
              status: block.is_error ? "failed" : "completed",
              outcome: { excerpt: excerpt(textOf(block.content)) },
            };
            ops.push({ op: "upsert", key: id, body, parentKey: m.parent_tool_use_id ?? undefined });
          }
          break;
        }
        case "result":
          last = m;
          break;
      }
      return ops;
    },
    outcome() {
      // Claude's usage and cost are running totals for the session (a resumed one starts from its saved totals): this
      // run's share is what they grew by since the baseline.
      const totals = last ? usageOf(last) : undefined;
      const usage = totals ? usageSince(totals, spec.session?.totals) : { ...ZERO_USAGE };
      const settled = (o: Outcome): Outcome => (totals ? { ...o, totals } : o);
      if (last && !last.is_error && last.subtype === "success") {
        if (spec.schema) {
          const data = last.structured_output;
          if (typeof data !== "object" || data === null || Array.isArray(data)) {
            return settled(failure("invalid_output", "structured output is missing or not an object", usage));
          }
          return settled({ ok: true, result: { kind: "data", data }, usage });
        }
        return settled({ ok: true, result: { kind: "text", text: last.result }, usage });
      }
      const code = errorCode(assistantError, last);
      const diagnostic = {
        ...(assistantError ? { assistantError } : {}),
        ...(last ? { subtype: last.subtype, terminalReason: last.terminal_reason } : {}),
      };
      return settled(failure(code, publicMessage(code), usage, Object.keys(diagnostic).length ? diagnostic : undefined));
    },
  };
}

function publicMessage(code: ErrorCode): string {
  switch (code) {
    case "auth_failed": return "Claude authentication failed";
    case "rate_limited": return "Claude rate limit exceeded";
    case "context_exceeded": return "Claude context window exceeded";
    case "limit_exceeded": return "the run reached its turn or cost limit";
    case "invalid_output": return "Claude did not produce output matching the schema";
    default: return "Claude execution failed";
  }
}

/** One changed file; `diff` only when there is one. */
function edit(path: string, change: "add" | "modify" | "delete", diff: string): Action {
  return { kind: "edit", changes: [{ path, change, ...(diff ? { diff: capDiff(diff) } : {}) }] };
}

/**
 * An edit's exact diff from its tool result: `structuredPatch` for Edit/MultiEdit/Write(update), the whole content for
 * Write(create). Anything else leaves the action as it was.
 */
function withResultDiff(action: Action, result: unknown): Action {
  if (action.kind !== "edit" || action.changes.length !== 1 || !result || typeof result !== "object") return action;
  const r = result as { type?: unknown; content?: unknown; structuredPatch?: unknown };
  const [change] = action.changes;
  if (r.type === "create" && typeof r.content === "string") return edit(change!.path, "add", addHunk(r.content));
  if (!Array.isArray(r.structuredPatch)) return action;
  return edit(change!.path, "modify", patchHunks(r.structuredPatch as PatchHunk[]));
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function agentMessage(text: string, status: "in_progress" | "completed"): ItemBody {
  return { type: "message", role: "agent", content: [{ kind: "text", text } satisfies Part], status };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (typeof (b as Obj).text === "string" ? (b as Obj).text : "")).join("\n");
  return "";
}

const ASSISTANT_ERRORS: Partial<Record<string, ErrorCode>> = {
  authentication_failed: "auth_failed", oauth_org_not_allowed: "auth_failed", cloud_credential_error: "auth_failed",
  billing_error: "auth_failed", account_on_hold: "auth_failed",
  rate_limit: "rate_limited", overloaded: "rate_limited",
};

const RESULT_ERRORS: Partial<Record<string, ErrorCode>> = {
  error_max_turns: "limit_exceeded", error_max_budget_usd: "limit_exceeded", error_max_structured_output_retries: "invalid_output",
};

const TERMINAL_ERRORS: Partial<Record<string, ErrorCode>> = {
  prompt_too_long: "context_exceeded", max_turns: "limit_exceeded", budget_exhausted: "limit_exceeded",
  structured_output_retry_exhausted: "invalid_output",
};

function errorCode(assistantError: string | undefined, last: SDKResultMessage | undefined): ErrorCode {
  return (assistantError && ASSISTANT_ERRORS[assistantError])
    || (last && (RESULT_ERRORS[last.subtype] ?? (last.terminal_reason && TERMINAL_ERRORS[last.terminal_reason])))
    || "engine_error";
}

/**
 * The session's running totals as of this result (`modelUsage` covers main, subagent and internal calls). Anthropic's
 * `inputTokens` excludes cache reads and writes; bo's `input_tokens` does not.
 */
function usageOf(last: SDKResultMessage): Usage {
  const models = Object.values(last.modelUsage ?? {});
  return {
    input_tokens: models.reduce((n, u) => n + u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens, 0),
    output_tokens: models.reduce((n, u) => n + u.outputTokens, 0),
    cached_input_tokens: models.reduce((n, u) => n + u.cacheReadInputTokens, 0),
    ...(typeof last.total_cost_usd === "number" ? { cost_usd: last.total_cost_usd } : {}),
  };
}
