import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { EngineId } from "../src/model.ts";

// Conformance transcript recording: projects raw native messages (as handed to a harness `onNative` tap) down to the
// fields the translators read, refuses anything that looks like a secret, and writes one JSONL file per scenario.

type Obj = Record<string, unknown>;

export interface TranscriptRecorder {
  /** Pass to a harness as `onNative`. */
  record(entry: unknown): void;
  flush(): Promise<void>;
}

export function createTranscriptRecorder(root: string, engine: EngineId, name: string): TranscriptRecorder {
  const entries: string[] = [];
  return {
    record(entry) {
      const projected = project(engine, entry);
      assertSafe(projected);
      entries.push(JSON.stringify(projected));
    },
    async flush() {
      const directory = path.join(root, engine);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, `${name}.jsonl`), entries.length ? `${entries.join("\n")}\n` : "");
    },
  };
}

function project(engine: EngineId, entry: unknown): unknown {
  const e = asObj(entry);
  if (engine === "claude-code" && e.message) return { message: projectClaude(e.message as SDKMessage) };
  if (engine === "codex" && typeof e.method === "string") return { method: e.method, params: projectCodex(e.method, asObj(e.params)) };
  return entry;
}

function projectClaude(message: SDKMessage): unknown {
  const m = message as unknown as Obj;
  switch (m.type) {
    case "system": {
      const projected = pick(m, ["type", "subtype", "session_id", "model", "attempt", "max_retries", "retry_delay_ms", "tool_use_id", "status", "summary", "ambient"]);
      if (Array.isArray(m.mcp_servers)) projected.mcp_servers = m.mcp_servers.map((server) => pick(asObj(server), ["name", "status"]));
      if (Array.isArray(m.tasks)) projected.tasks = m.tasks.map((task) => pick(asObj(task), ["task_id", "ambient"]));
      return projected;
    }
    case "stream_event": return { type: m.type, parent_tool_use_id: m.parent_tool_use_id, event: projectStream(asObj(m.event)) };
    case "assistant": return {
      type: m.type, error: m.error, parent_tool_use_id: m.parent_tool_use_id,
      message: projectClaudeAssistant(asObj(m.message)),
    };
    case "user": return {
      type: m.type, parent_tool_use_id: m.parent_tool_use_id,
      message: { content: projectClaudeBlocks(asObj(m.message).content) },
      tool_use_result: projectTaskResult(m.tool_use_result),
    };
    case "result": {
      const projected = pick(m, [
        "type", "subtype", "is_error", "result", "structured_output", "terminal_reason", "total_cost_usd",
      ]);
      if (m.modelUsage && typeof m.modelUsage === "object" && !Array.isArray(m.modelUsage)) projected.modelUsage = Object.fromEntries(Object.entries(m.modelUsage as Obj).map(([model, usage]) => [
        model, pick(asObj(usage), ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"]),
      ]));
      return projected;
    }
    default: return { type: m.type };
  }
}

function projectCodex(method: string, raw: Obj): Obj {
  switch (method) {
    case "item/started":
    case "item/completed": return { threadId: raw.threadId, item: projectCodexItem(asObj(raw.item)) };
    case "item/agentMessage/delta": return pick(raw, ["itemId", "delta"]);
    case "thread/tokenUsage/updated": {
      const usage = asObj(raw.tokenUsage);
      const breakdown = (v: unknown) => pick(asObj(v), ["inputTokens", "outputTokens", "cachedInputTokens"]);
      return { threadId: raw.threadId, tokenUsage: { total: breakdown(usage.total), ...(usage.last ? { last: breakdown(usage.last) } : {}) } };
    }
    case "mcpServer/startupStatus/updated": return pick(raw, ["name", "status", "error"]);
    case "turn/plan/updated": return { threadId: raw.threadId, plan: Array.isArray(raw.plan) ? raw.plan.map((s) => pick(asObj(s), ["step", "status"])) : [] };
    case "error": return { willRetry: raw.willRetry, error: pick(asObj(raw.error), ["message", "codexErrorInfo"]) };
    case "turn/completed": {
      const turn = asObj(raw.turn);
      return { threadId: raw.threadId, turn: { ...pick(turn, ["id", "status"]), ...(turn.error ? { error: pick(asObj(turn.error), ["message", "codexErrorInfo"]) } : {}) } };
    }
    default: return {};
  }
}

function projectStream(event: Obj): Obj {
  const out = pick(event, ["type", "index"]);
  const usage = (u: unknown) => pick(asObj(u), ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]);
  if (event.type === "message_start") out.message = { ...pick(asObj(event.message), ["id"]), usage: usage(asObj(event.message).usage) };
  if (event.type === "message_delta" && event.usage) out.usage = usage(event.usage);
  if (event.type === "content_block_start") out.content_block = pick(asObj(event.content_block), ["type"]);
  if (event.type === "content_block_delta") out.delta = pick(asObj(event.delta), ["type", "text"]);
  return out;
}

function projectClaudeAssistant(message: Obj): Obj {
  return { id: message.id, content: projectClaudeBlocks(message.content) };
}

function projectClaudeBlocks(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const block = asObj(entry);
    const projected = pick(block, ["type", "id", "name", "text", "thinking", "tool_use_id", "is_error", "content"]);
    if (block.type === "tool_use") projected.input = projectToolInput(String(block.name ?? ""), asObj(block.input));
    return projected;
  });
}

/** The parts of a tool's structured result the translator reads: created tasks, edit patches, subagent tokens. */
function projectTaskResult(value: unknown): unknown {
  const result = asObj(value);
  const task = asObj(result.task);
  const projected = {
    ...(Object.keys(task).length ? { task: pick(task, ["id", "subject"]) } : {}),
    ...pick(result, ["type", "structuredPatch", "totalTokens"]),
    ...(result.type === "create" ? pick(result, ["content"]) : {}),
  };
  return Object.keys(projected).length ? projected : undefined;
}

function projectCodexItem(item: Obj): Obj {
  const projected = pick(item, ["type", "id", "status"]);
  switch (item.type) {
    case "agentMessage": Object.assign(projected, pick(item, ["text", "phase"])); break;
    case "reasoning": Object.assign(projected, pick(item, ["summary", "content"])); break;
    case "commandExecution":
      Object.assign(projected, pick(item, ["command", "exitCode", "aggregatedOutput"]));
      if (Array.isArray(item.commandActions)) projected.commandActions = item.commandActions.map((a) => pick(asObj(a), ["type", "command", "name", "path", "query"]));
      break;
    case "fileChange":
      projected.changes = Array.isArray(item.changes) ? item.changes.map((change) => {
        const value = asObj(change);
        return { path: value.path, diff: value.diff, kind: pick(asObj(value.kind), ["type"]) };
      }) : [];
      break;
    case "mcpToolCall": Object.assign(projected, pick(item, ["server", "tool"])); break;
    case "webSearch":
      Object.assign(projected, pick(item, ["query"]));
      if (item.action) projected.action = pick(asObj(item.action), ["type", "url"]);
      break;
    case "imageView": Object.assign(projected, pick(item, ["path"])); break;
    case "collabAgentToolCall": Object.assign(projected, pick(item, ["prompt", "receiverThreadIds"])); break;
  }
  return projected;
}

function projectToolInput(name: string, input: Obj): Obj {
  switch (name) {
    case "Bash": return pick(input, ["command"]);
    case "Read": return pick(input, ["file_path"]);
    case "Edit": return pick(input, ["file_path", "old_string", "new_string"]);
    case "MultiEdit": return pick(input, ["file_path", "edits"]);
    case "Write": return pick(input, ["file_path", "content"]);
    case "NotebookEdit": return pick(input, ["notebook_path"]);
    case "Grep":
    case "Glob": return pick(input, ["pattern"]);
    case "WebFetch": return pick(input, ["url"]);
    case "WebSearch": return pick(input, ["query"]);
    case "Agent":
    case "Task": return pick(input, ["subagent_type", "description", "prompt"]);
    case "Skill": return pick(input, ["skill"]);
    case "TaskCreate": return pick(input, ["subject", "description"]);
    case "TaskUpdate": return pick(input, ["taskId", "subject", "status"]);
    case "TodoWrite": return { todos: Array.isArray(input.todos) ? input.todos.map((todo) => pick(asObj(todo), ["content", "status"])) : [] };
    default: return {};
  }
}

function pick(value: Obj, keys: readonly string[]): Obj {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function asObj(value: unknown): Obj {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
}

const SENSITIVE_KEY = /^(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|cookie|account|email|environment|env|headers?)$/i;

function assertSafe(value: unknown, key = ""): void {
  if (SENSITIVE_KEY.test(key)) throw new Error(`unsafe transcript field: ${key}`);
  if (typeof value === "string" && (value.includes(os.homedir()) || /^Bearer\s/i.test(value))) throw new Error("unsafe transcript value");
  if (Array.isArray(value)) { for (const child of value) assertSafe(child, key); return; }
  if (value && typeof value === "object") for (const [childKey, child] of Object.entries(value as Obj)) assertSafe(child, childKey);
}
