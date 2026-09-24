// Hand-written subset of the `codex app-server` v2 protocol (codex-cli 0.155.1), exactly the fields bo uses.
// Source of truth: `codex app-server generate-json-schema --out <dir>`.

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type AskForApproval = "on-request" | "never";

export type SandboxPolicy =
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "workspaceWrite"; writableRoots: string[]; networkAccess: boolean; excludeSlashTmp?: boolean; excludeTmpdirEnvVar?: boolean }
  | { type: "dangerFullAccess" };

export type UserInput = { type: "text"; text: string } | { type: "localImage"; path: string };

export interface ThreadParams {
  cwd: string;
  model?: string;
  sandbox: SandboxMode;
  approvalPolicy: AskForApproval;
  developerInstructions?: string;
  config: Record<string, unknown>;
}

export interface ThreadResponse { thread: { id: string }; model: string }
export interface TurnStartResponse { turn: { id: string } }

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";
export type CodexErrorInfo = string | Record<string, unknown>;
export interface TurnError { message: string; codexErrorInfo?: CodexErrorInfo | null }
export interface Turn { id: string; status: TurnStatus; error?: TurnError | null }

export type ItemStatus = "inProgress" | "completed" | "failed" | "declined";

export type ThreadItem =
  | { type: "agentMessage"; id: string; text: string; phase?: "commentary" | "final_answer" | null }
  | { type: "reasoning"; id: string; summary?: string[]; content?: string[] }
  | {
    type: "commandExecution"; id: string; command: string; status: ItemStatus; exitCode?: number | null; aggregatedOutput?: string | null;
    commandActions?: CommandAction[];
  }
  /** `diff`: unified hunks for `update`; the file's content for `add` (verified live); the removed content for `delete`. */
  | { type: "fileChange"; id: string; status: ItemStatus; changes: { path: string; diff: string; kind: { type: "add" | "delete" | "update" } }[] }
  | { type: "mcpToolCall"; id: string; server: string; tool: string; status: ItemStatus }
  | { type: "webSearch"; id: string; query: string; action?: { type: string; url?: string | null } | null }
  | { type: "imageView"; id: string; path: string }
  | { type: "contextCompaction"; id: string }
  | { type: "collabAgentToolCall"; id: string; prompt?: string | null; receiverThreadIds: string[]; status: ItemStatus }
  | { type: string; id: string };

export type CommandAction =
  | { type: "read"; command: string; name: string; path: string }
  | { type: "listFiles"; command: string; path?: string | null }
  | { type: "search"; command: string; query?: string | null; path?: string | null }
  | { type: "unknown"; command: string };

export interface McpStartupStatus { name: string; status: "starting" | "ready" | "failed" | "cancelled"; error?: string | null }

export interface ItemNotification { item: ThreadItem; threadId: string; turnId: string }
export interface AgentMessageDelta { itemId: string; delta: string; threadId: string }

/** `inputTokens` includes `cachedInputTokens`; `outputTokens` includes reasoning tokens. */
export interface TokenUsageBreakdown { inputTokens: number; cachedInputTokens: number; outputTokens: number }
/** `last` is the model call that just finished (bo sums these; the thread's running `total` is not read). */
export interface TokenUsageUpdated { threadId: string; tokenUsage: { last?: TokenUsageBreakdown } }
export interface ErrorNotification { error: TurnError; threadId: string; willRetry: boolean }
export interface TurnCompleted { threadId: string; turn: Turn }
export interface PlanUpdated { threadId: string; plan: { step: string; status: "pending" | "inProgress" | "completed" }[] }

export interface CommandApprovalParams { itemId: string; threadId: string; command?: string | null; reason?: string | null }
export interface FileChangeApprovalParams { itemId: string; threadId: string; reason?: string | null }
export interface PermissionsApprovalParams { itemId: string; threadId: string; reason?: string | null; permissions: Record<string, unknown> }
export interface UserInputParams {
  itemId: string; threadId: string;
  questions: { id: string; question: string; header: string; options?: { label: string; description: string }[] | null }[];
}

export type Account = { type: "apiKey" } | { type: "chatgpt"; email: string | null; planType: string } | { type: "amazonBedrock" };
export interface AccountResponse { account: Account | null; requiresOpenaiAuth: boolean }
export interface Model {
  id: string;
  model: string;
  isDefault: boolean;
  hidden?: boolean;
  supportedReasoningEfforts?: { reasoningEffort: string; description: string }[];
  inputModalities?: ("text" | "image" | "audio")[];
}
export interface ModelListResponse { data: Model[] }
