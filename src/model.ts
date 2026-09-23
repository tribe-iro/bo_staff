// The bo standard: every public shape, and nothing else. No harness vocabulary lives here.

export type EngineId = "claude-code" | "codex";
export const ENGINE_IDS: readonly EngineId[] = ["claude-code", "codex"];

export type Access = "read" | "write" | "full";
export const ACCESS_LEVELS: readonly Access[] = ["read", "write", "full"];

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export type Part =
  | { kind: "text"; text: string }
  | { kind: "image"; path: string; media_type: ImageMediaType }
  | { kind: "data"; data: unknown };

/** A run result is text or structured data; images are input-only. */
export type ResultPart = Exclude<Part, { kind: "image" }>;

export type McpServer =
  | { command: string; args?: string[]; env?: Record<string, string>; tools?: string[] }
  | { url: string; headers?: Record<string, string>; tools?: string[] };

export interface Subagent {
  description: string;
  instructions: string;
  model?: string;
  /** One of the subagent's model's `efforts` (its `model`, else the run's model, else the engine default). */
  effort?: string;
}

export interface RunSpec {
  input: Part[];
  workspace: { root: string; extra_roots?: string[] };
  engine?: EngineId;
  model?: string;
  /** One of the selected model's `efforts` in `GET /v1/engines`. */
  effort?: string;
  instructions?: string;
  /** Include the workspace root's AGENTS.md and CLAUDE.md in the instructions (default true). */
  project_instructions?: boolean;
  skills?: string[];
  mcp?: Record<string, McpServer>;
  subagents?: Record<string, Subagent>;
  permissions?: { access?: Access; internet?: boolean };
  interactive?: boolean;
  /** Variables for the engine and every tool it runs. `BO_*` names are reserved. */
  env?: Record<string, string>;
  /**
   * Caller-set ceilings, enforced by bo for every engine: the run fails with `limit_exceeded` at the first model call
   * past one. `max_turns` counts the agent's own model calls; `max_tokens` counts input (cached included) plus output
   * tokens of every model call in the run, subagents included.
   */
  limits?: { max_turns?: number; max_tokens?: number };
  output?: { schema: Record<string, unknown> };
  /** Continue a session: a given one, or the latest in this workspace (for `engine`, when set). `fork` branches it. */
  session?: { id: string; fork?: boolean } | { latest: true; fork?: boolean };
  timeout_s?: number;
}

/** A conversation: one engine, one workspace, many runs. Durable across server restarts. */
export interface Session {
  id: string;
  engine: EngineId;
  /** The workspace root the session runs in. */
  workspace: string;
  /** The first line of the prompt that started it. */
  title: string;
  model: string | null;
  runs: number;
  created_at: string;
  updated_at: string;
}

export type RunStatus = "running" | "waiting" | "completed" | "failed" | "cancelled";
export const TERMINAL: ReadonlySet<RunStatus> = new Set(["completed", "failed", "cancelled"]);

export type ErrorCode =
  | "auth_failed" | "rate_limited" | "context_exceeded" | "timeout"
  | "invalid_output" | "limit_exceeded" | "resource_exhausted" | "engine_unavailable" | "engine_error";

/**
 * Totals for the session so far, including runs it resumed or forked from. `input_tokens` counts every input token
 * (cached ones included), `cached_input_tokens` the input tokens read from cache, `output_tokens` every output token
 * (reasoning included). `cost_usd` is the engine's estimate, when it has one.
 */
export interface Usage { input_tokens: number; output_tokens: number; cached_input_tokens: number; cost_usd?: number }

export interface Run {
  id: string;
  session_id: string | null;
  status: RunStatus;
  engine: { id: EngineId; version: string };
  model: string | null;
  created_at: string;
  ended_at?: string;
  result?: ResultPart;
  error?: { code: ErrorCode; message: string; path?: string };
  usage: Usage;
}

export type Action =
  | { kind: "shell"; command: string }
  | { kind: "read"; paths: string[] }
  | { kind: "edit"; changes: { path: string; change: "add" | "modify" | "delete" }[] }
  | { kind: "search"; query: string }
  | { kind: "web"; url?: string; query?: string }
  | { kind: "mcp"; server: string; tool: string }
  | { kind: "delegate"; subagent?: string; task: string }
  | { kind: "skill"; name: string }
  | { kind: "other"; name: string };

export interface Question { id: string; text: string; options?: string[]; multiple: boolean }

export type ActionStatus = "awaiting_approval" | "running" | "completed" | "failed" | "denied";

export type MessageItem = { type: "message"; role: "user" | "agent"; content: Part[]; status: "in_progress" | "completed" };
export type ActionItem = {
  type: "action"; action: Action; status: ActionStatus;
  reason?: string; outcome?: { exit_code?: number; excerpt?: string };
};
export type QuestionItem = {
  type: "question"; questions: Question[]; status: "awaiting_answer" | "answered" | "expired";
  answers?: Record<string, string[]>;
};

export type ItemBody =
  | MessageItem
  | { type: "reasoning"; text: string }
  | { type: "plan"; steps: { text: string; status: "pending" | "in_progress" | "completed" }[] }
  | ActionItem
  | QuestionItem
  | { type: "notice"; level: "info" | "warning"; text: string };

export type AwaitableBody = (ActionItem & { status: "awaiting_approval" }) | (QuestionItem & { status: "awaiting_answer" });

export type Item = ItemBody & { id: string; parent_id?: string; created_at: string };

/**
 * `allow_for_run` allows every later action of the same kind for the rest of the run; for `mcp`, the same
 * server and tool; for `other`, the same name.
 */
export type Decision = "allow" | "allow_for_run" | "deny";
export type Response = { decision: Decision } | { answers: Record<string, string[]> };

export type AuthKind = "api_key" | "cloud_provider" | "subscription" | "none";

/** `id` is canonical; `aliases` are accepted in `RunSpec.model` and resolve to `id`. `images`: accepts image input. */
export interface ModelInfo { id: string; aliases: string[]; default: boolean; efforts: string[]; images: boolean }

export interface EngineInfo {
  id: EngineId;
  available: boolean;
  reason?: string;
  version?: string;
  authentication: AuthKind;
  models: ModelInfo[];
}

export type StreamEvent =
  | { event: "run"; id: number; data: Run }
  | { event: "item"; id: number; data: Item }
  | { event: "delta"; data: { item_id: string; text: string } };
