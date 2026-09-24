// The bo contract: every public shape, once. TypeScript types (`model.ts`), request validation (`validate.ts`) and the
// published JSON Schema / OpenAPI documents (`npm run contract`) all come from here.

import { Type, type Static, type TSchema } from "typebox";

export const CONTRACT_VERSION = 1;

// ---- building blocks ----

/** A string with at least one non-space character. */
const Text = (description?: string) => Type.String({ minLength: 1, pattern: "\\S", ...(description ? { description } : {}) });
/** An absolute path on the server's machine. */
const AbsolutePath = (description?: string) => Type.String({ pattern: "^/", ...(description ? { description } : {}) });

/** A string enum (`enum`, the form validators report best). */
function Strings<const T extends readonly string[]>(values: T, description?: string) {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...(description ? { description } : {}) });
}

/** A union discriminated by `key` (`oneOf` + `discriminator`: errors name the member the caller meant). */
function Tagged<const K extends string, const M extends TSchema[]>(key: K, members: M, description?: string) {
  const tags = members.map((m) => (m as { properties: Record<string, { const: string }> }).properties[key]!.const);
  return Type.Unsafe<Static<M[number]>>({
    type: "object", required: [key], properties: { [key]: { type: "string", enum: tags } },
    discriminator: { propertyName: key }, oneOf: members, ...(description ? { description } : {}),
  });
}

/** An object used as a map: keys matching `pattern`, at most `max` entries. */
function MapOf<V extends TSchema>(pattern: string, max: number, value: V, description?: string) {
  return Type.Unsafe<Record<string, Static<V>>>({
    type: "object", propertyNames: { pattern }, maxProperties: max, additionalProperties: value, ...(description ? { description } : {}),
  });
}

const Closed = { additionalProperties: false } as const;
const SESSION_KEY = "^[A-Za-z0-9._:-]{1,128}$";
const Timestamp = Type.String({ format: "date-time" });

// ---- vocabularies ----

export const ENGINE_IDS = ["claude-code", "codex"] as const;
export const ACCESS_LEVELS = ["read", "write", "full"] as const;
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const RUN_STATUSES = ["running", "waiting", "completed", "failed", "cancelled"] as const;
export const ERROR_CODES = [
  "auth_failed", "rate_limited", "context_exceeded", "timeout", "invalid_output", "limit_exceeded",
  "resource_exhausted", "engine_unavailable", "engine_error",
] as const;
export const DECISIONS = ["allow", "allow_for_run", "deny"] as const;

export const EngineId = Strings(ENGINE_IDS);
export const Access = Strings(ACCESS_LEVELS);
export const ImageMediaType = Strings(IMAGE_MEDIA_TYPES);

// ---- input ----

const TextPartOf = <T extends TSchema>(text: T) => Type.Object({ kind: Type.Literal("text"), text }, Closed);
export const ImagePart = Type.Object({
  kind: Type.Literal("image"), path: AbsolutePath("a file of at most 5 MiB on the server's machine"), media_type: ImageMediaType,
}, Closed);
export const DataPart = Type.Object({ kind: Type.Literal("data"), data: Type.Unknown({ description: "any JSON; at most 262144 characters serialized" }) }, Closed);
/** A part as bo reports it (an agent message being streamed may still be empty). */
export const Part = Tagged("kind", [TextPartOf(Type.String()), ImagePart, DataPart]);
/** A part a caller sends: text must not be blank. */
export const InputPart = Tagged("kind", [TextPartOf(Text()), ImagePart, DataPart]);
/** A run result is text or structured data; images are input-only. */
export const ResultPart = Tagged("kind", [TextPartOf(Type.String()), DataPart]);

const StringMap = (description?: string) => Type.Record(Type.String(), Type.String(), description ? { description } : {});
const ToolAllowlist = Type.Array(Type.String(), { description: "an enforced allowlist of the server's tools" });
export const McpStdio = Type.Object({
  command: Text(), args: Type.Optional(Type.Array(Type.String())), env: Type.Optional(StringMap()), tools: Type.Optional(ToolAllowlist),
}, Closed);
export const McpHttp = Type.Object({
  url: Type.String({ format: "uri" }), headers: Type.Optional(StringMap()), tools: Type.Optional(ToolAllowlist),
}, Closed);
/** Stdio (`command`) or HTTP (`url`). */
export const McpServer = Type.Unsafe<Static<typeof McpStdio> | Static<typeof McpHttp>>({
  type: "object", if: { properties: { command: {} }, required: ["command"] }, then: McpStdio, else: McpHttp,
});

export const Subagent = Type.Object({
  description: Text(), instructions: Text(), model: Type.Optional(Text()),
  effort: Type.Optional(Text("one of the subagent's model's efforts (its model, else the run's, else the default)")),
}, Closed);

export const RunSpec = Type.Object({
  input: Type.Array(InputPart, { minItems: 1, maxItems: 64 }),
  workspace: Type.Object({
    root: AbsolutePath("an existing directory"),
    extra_roots: Type.Optional(Type.Array(AbsolutePath(), { maxItems: 16, description: "directories outside the root the run may also use" })),
  }, Closed),
  engine: Type.Optional(EngineId),
  model: Type.Optional(Text("a model id or alias from GET /v1/engines")),
  effort: Type.Optional(Text("one of the selected model's efforts in GET /v1/engines")),
  instructions: Type.Optional(Text()),
  project_instructions: Type.Optional(Type.Boolean({ description: "include the root's AGENTS.md and CLAUDE.md (default true)" })),
  skills: Type.Optional(Type.Array(AbsolutePath("a directory containing SKILL.md"), { maxItems: 32 })),
  mcp: Type.Optional(MapOf("^[A-Za-z0-9_-]{1,64}$", 64, McpServer)),
  subagents: Type.Optional(MapOf("^[a-z0-9-]{1,64}$", 16, Subagent)),
  permissions: Type.Optional(Type.Object({ access: Type.Optional(Access), internet: Type.Optional(Type.Boolean()) }, Closed)),
  interactive: Type.Optional(Type.Boolean()),
  env: Type.Optional(MapOf("^[A-Za-z_][A-Za-z0-9_]*$", 64, Type.String(), "variables for the engine and its tools; BO_* names are reserved")),
  limits: Type.Optional(Type.Object({
    max_turns: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000, description: "the agent's own model calls" })),
    max_tokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000_000, description: "input (cached included) and output tokens of every model call, subagents included" })),
  }, Closed)),
  output: Type.Optional(Type.Object({ schema: Type.Record(Type.String(), Type.Unknown(), { description: "a draft-07 JSON Schema of type object, at most 64 KiB" }) }, Closed)),
  session: Type.Optional(Type.Object({
    id: Type.Optional(Type.String({ description: "a session id issued by bo" })),
    latest: Type.Optional(Type.Literal(true, { description: "this workspace's latest session (for engine, when set)" })),
    key: Type.Optional(Type.String({ pattern: SESSION_KEY, description: "the session with this caller-chosen key in this workspace, started (with the key) if there is none" })),
    fork: Type.Optional(Type.Boolean()),
  }, { ...Closed, description: "continue a session: exactly one of id, latest or key" })),
  timeout_s: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400 })),
}, Closed);

export const MessageBody = Type.Object({ content: Type.Array(InputPart, { minItems: 1, maxItems: 64 }) }, Closed);
export const ResponseBody = Type.Object({
  decision: Type.Optional(Strings(DECISIONS)),
  answers: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))),
}, { ...Closed, description: "exactly one of decision (an action) or answers (a question)" });

// ---- output ----

export const Usage = Type.Object({
  input_tokens: Type.Integer({ minimum: 0 }), output_tokens: Type.Integer({ minimum: 0 }),
  cached_input_tokens: Type.Integer({ minimum: 0 }), cost_usd: Type.Optional(Type.Number({ minimum: 0 })),
}, Closed);

export const Run = Type.Object({
  id: Type.String(),
  session_id: Type.Union([Type.String(), Type.Null()]),
  status: Strings(RUN_STATUSES),
  engine: Type.Object({ id: EngineId, version: Type.String() }, Closed),
  model: Type.Union([Type.String(), Type.Null()]),
  created_at: Timestamp,
  ended_at: Type.Optional(Timestamp),
  result: Type.Optional(ResultPart),
  error: Type.Optional(Type.Object({
    code: Strings(ERROR_CODES), message: Type.String(),
    path: Type.Optional(Type.String({ description: "what it concerns: the failing field of structured output, or the limit reached (/limits/max_turns, /limits/max_tokens)" })),
  }, Closed)),
  usage: Usage,
}, Closed);

export const Action = Tagged("kind", [
  Type.Object({ kind: Type.Literal("shell"), command: Type.String() }, Closed),
  Type.Object({ kind: Type.Literal("read"), paths: Type.Array(Type.String()) }, Closed),
  Type.Object({
    kind: Type.Literal("edit"),
    changes: Type.Array(Type.Object({
      path: Type.String(),
      change: Strings(["add", "modify", "delete"] as const),
      diff: Type.Optional(Type.String({ description: "unified hunks without file headers (@@ -a,b +c,d @@, or @@ @@ while line numbers are unknown); at most 64 KiB, then the line `\\ diff truncated`" })),
    }, Closed)),
  }, Closed),
  Type.Object({ kind: Type.Literal("search"), query: Type.String() }, Closed),
  Type.Object({ kind: Type.Literal("web"), url: Type.Optional(Type.String()), query: Type.Optional(Type.String()) }, Closed),
  Type.Object({ kind: Type.Literal("mcp"), server: Type.String(), tool: Type.String() }, Closed),
  Type.Object({ kind: Type.Literal("delegate"), subagent: Type.Optional(Type.String()), task: Type.String() }, Closed),
  Type.Object({ kind: Type.Literal("skill"), name: Type.String() }, Closed),
  Type.Object({ kind: Type.Literal("other"), name: Type.String() }, Closed),
]);

export const Question = Type.Object({
  id: Type.String(), text: Type.String(), options: Type.Optional(Type.Array(Type.String())), multiple: Type.Boolean(),
}, Closed);

const ItemCommon = {
  id: Type.String(),
  parent_id: Type.Optional(Type.String({ description: "the delegate action a subagent's item belongs to" })),
  created_at: Timestamp,
};
export const MessageItem = Type.Object({
  ...ItemCommon, type: Type.Literal("message"), role: Strings(["user", "agent"] as const), content: Type.Array(Part),
  status: Strings(["in_progress", "completed"] as const),
}, Closed);
export const ReasoningItem = Type.Object({ ...ItemCommon, type: Type.Literal("reasoning"), text: Type.String() }, Closed);
export const PlanItem = Type.Object({
  ...ItemCommon, type: Type.Literal("plan"),
  steps: Type.Array(Type.Object({ text: Type.String(), status: Strings(["pending", "in_progress", "completed"] as const) }, Closed)),
}, Closed);
export const ActionItem = Type.Object({
  ...ItemCommon, type: Type.Literal("action"), action: Action,
  status: Strings(["awaiting_approval", "running", "completed", "failed", "denied"] as const),
  reason: Type.Optional(Type.String()),
  outcome: Type.Optional(Type.Object({ exit_code: Type.Optional(Type.Integer()), excerpt: Type.Optional(Type.String()) }, Closed)),
}, Closed);
export const QuestionItem = Type.Object({
  ...ItemCommon, type: Type.Literal("question"), questions: Type.Array(Question),
  status: Strings(["awaiting_answer", "answered", "expired"] as const),
  answers: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))),
}, Closed);
export const NoticeItem = Type.Object({
  ...ItemCommon, type: Type.Literal("notice"), level: Strings(["info", "warning"] as const), text: Type.String(),
}, Closed);
export const Item = Tagged("type", [MessageItem, ReasoningItem, PlanItem, ActionItem, QuestionItem, NoticeItem]);

export const Session = Type.Object({
  id: Type.String(), engine: EngineId, workspace: Type.String({ description: "the workspace root" }),
  title: Type.String({ description: "the first line of the prompt that started it" }),
  key: Type.Optional(Type.String({ description: "the caller-chosen key, when it was started with one" })),
  model: Type.Union([Type.String(), Type.Null()]), runs: Type.Integer({ minimum: 0 }),
  usage: Usage, created_at: Timestamp, updated_at: Timestamp,
}, Closed);
export const SessionRun = Type.Object({ run: Run, items: Type.Array(Item) }, Closed);

export const ModelInfo = Type.Object({
  id: Type.String({ description: "canonical; aliases resolve to it" }), aliases: Type.Array(Type.String()),
  default: Type.Boolean(), efforts: Type.Array(Type.String()), images: Type.Boolean({ description: "accepts image input" }),
}, Closed);
export const EngineInfo = Type.Object({
  id: EngineId, available: Type.Boolean(), reason: Type.Optional(Type.String()), version: Type.Optional(Type.String()),
  authentication: Strings(["api_key", "cloud_provider", "subscription", "none"] as const), models: Type.Array(ModelInfo),
}, Closed);

export const StreamEvent = Tagged("event", [
  Type.Object({ event: Type.Literal("run"), id: Type.Integer({ minimum: 1 }), data: Run }, Closed),
  Type.Object({ event: Type.Literal("item"), id: Type.Integer({ minimum: 1 }), data: Item }, Closed),
  Type.Object({
    event: Type.Literal("delta"),
    data: Type.Object({
      item_id: Type.String(),
      offset: Type.Integer({ minimum: 0, description: "where `text` starts in the item's streamed text, in Unicode code points" }),
      text: Type.String(),
    }, Closed),
  }, {
    ...Closed,
    description: "Text streamed into an item since its latest version. Not logged, so it has no id; on (re)connect the "
      + "text so far arrives as one delta at offset 0: append the part past what you already have.",
  }),
]);

export const FieldError = Type.Object({ pointer: Type.String(), detail: Type.String() }, Closed);
export const Problem = Type.Object({
  type: Type.String({ description: "urn:bo:problem:<name>" }), title: Type.String(), status: Type.Integer(), detail: Type.String(),
  errors: Type.Optional(Type.Array(FieldError)),
}, Closed);

/** Every public schema by name: the `$defs` of the published document. */
export const SCHEMAS = {
  RunSpec, MessageBody, ResponseBody, InputPart, Part, ResultPart, McpServer, Subagent, Usage, Run, Action, Question, Item,
  Session, SessionRun, ModelInfo, EngineInfo, StreamEvent, FieldError, Problem,
} as const;
