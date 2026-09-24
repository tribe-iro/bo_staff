// Pure translation between bo and ACP v1: bo items → `session/update`s, ACP prompts → bo input parts, and the
// config options that choose engine, model, effort and access. No I/O.

import * as acp from "@agentclientprotocol/sdk";
import { summary } from "../format.ts";
import type { Access, Action, EngineInfo, Item, McpServer, Part, Usage } from "../model.ts";

// ---- configuration ----

/** bo access presets offered as ACP modes. */
export const MODES = [
  { id: "read", name: "Read workspace", description: "workspace is read only; configured MCP tools are authorized separately", access: "read" as Access, internet: false },
  { id: "write", name: "Edit the workspace", description: "edits the workspace; no internet", access: "write" as Access, internet: false },
  { id: "write-internet", name: "Edit + internet", description: "edits the workspace, with internet", access: "write" as Access, internet: true },
  { id: "full", name: "Full access", description: "no sandbox", access: "full" as Access, internet: true },
] as const;
export type ModeId = (typeof MODES)[number]["id"];

/** What a session's next run uses. */
export interface Choice { engine: EngineInfo["id"]; model?: string; effort?: string; mode: ModeId }

/** The modes this process offers: `full` never when bo runs as root. */
export function modes(root: boolean): (typeof MODES)[number][] {
  return MODES.filter((m) => !(root && m.id === "full"));
}

/** `model` (grouped by engine), `effort` (the model's), `mode`: always the full set. */
export function configOptions(engines: readonly EngineInfo[], choice: Choice, root: boolean): acp.SessionConfigOption[] {
  const model = selectedModel(engines, choice);
  return [
    {
      id: "model", name: "Model", category: "model", type: "select",
      currentValue: `${choice.engine}/${model?.id ?? "default"}`,
      options: engines.filter((e) => e.available).map((e) => ({
        group: e.id, name: e.id,
        options: e.models.length
          ? e.models.map((m) => ({ value: `${e.id}/${m.id}`, name: m.default ? `${m.id} (default)` : m.id }))
          : [{ value: `${e.id}/default`, name: "default" }],
      })),
    },
    {
      id: "effort", name: "Effort", category: "thought_level", type: "select",
      currentValue: choice.effort ?? "default",
      options: [{ value: "default", name: "default" }, ...(model?.efforts ?? []).map((e) => ({ value: e, name: e }))],
    },
    {
      id: "mode", name: "Mode", category: "mode", type: "select", currentValue: choice.mode,
      options: modes(root).map((m) => ({ value: m.id, name: m.name, description: m.description })),
    },
  ];
}

/** Every value a config option offers (groups flattened). */
export function optionValues(option: acp.SessionConfigOption): string[] {
  if (option.type !== "select") return ["true", "false"];
  return (option.options as (acp.SessionConfigSelectOption | acp.SessionConfigSelectGroup)[])
    .flatMap((o) => ("options" in o ? o.options.map((x) => x.value) : [o.value]));
}

export function modeState(choice: Choice, root: boolean): acp.SessionModeState {
  return { currentModeId: choice.mode, availableModes: modes(root).map(({ id, name, description }) => ({ id, name, description })) };
}

/** The model a choice runs with: the chosen one, else the engine's default. */
export function selectedModel(engines: readonly EngineInfo[], choice: Choice): EngineInfo["models"][number] | undefined {
  const models = engines.find((e) => e.id === choice.engine)?.models ?? [];
  return models.find((m) => m.id === choice.model) ?? models.find((m) => m.default);
}

// ---- input ----

/** ACP MCP servers → `RunSpec.mcp`: names normalised to what bo accepts; two servers that end up with one name are refused. */
export function mcpServers(servers: readonly acp.McpServer[]): Record<string, McpServer> {
  const out: Record<string, McpServer> = {};
  const named = new Map<string, string>();
  for (const s of servers) {
    const name = s.name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "server";
    const other = named.get(name);
    if (other !== undefined) {
      throw acp.RequestError.invalidParams({ mcpServers: [other, s.name] }, `MCP servers "${other}" and "${s.name}" are both named ${name} to bo; rename one`);
    }
    named.set(name, s.name);
    if ("command" in s) {
      out[name] = { command: s.command, args: s.args, env: Object.fromEntries(s.env.map((e) => [e.name, e.value])) };
    } else if ("url" in s) {
      out[name] = { url: s.url, headers: Object.fromEntries(s.headers.map((h) => [h.name, h.value])) };
    }
  }
  return out;
}

/** ACP prompt blocks → bo parts; images are written to files by `saveImage` (bo reads images from paths). */
export async function promptParts(blocks: readonly acp.ContentBlock[], saveImage: (data: string, mimeType: string) => Promise<string>): Promise<Part[]> {
  const parts: Part[] = [];
  for (const b of blocks) {
    if (b.type === "text") { if (b.text.trim()) parts.push({ kind: "text", text: b.text }); }
    else if (b.type === "image") parts.push({ kind: "image", path: await saveImage(b.data, b.mimeType), media_type: b.mimeType as Extract<Part, { kind: "image" }>["media_type"] });
    else if (b.type === "resource_link") parts.push({ kind: "text", text: `[@${b.name}](${b.uri})` });
    else if (b.type === "resource" && "text" in b.resource) parts.push({ kind: "text", text: `<context uri="${b.resource.uri}">\n${b.resource.text}\n</context>` });
  }
  return parts;
}

// ---- output ----

const STATUS: Record<Extract<Item, { type: "action" }>["status"], acp.ToolCallStatus> = {
  awaiting_approval: "pending", running: "in_progress", completed: "completed", failed: "failed", denied: "failed",
};

export function toolKind(a: Action): acp.ToolKind {
  switch (a.kind) {
    case "shell": return "execute";
    case "read": return "read";
    case "edit": return a.changes.every((c) => c.change === "delete") ? "delete" : "edit";
    case "search": return "search";
    case "web": return "fetch";
    case "delegate": return "think";
    default: return "other";
  }
}

function locations(a: Action): acp.ToolCallLocation[] {
  if (a.kind === "read") return a.paths.map((path) => ({ path }));
  if (a.kind === "edit") return a.changes.map((c) => ({ path: c.path }));
  return [];
}

/** A unified diff's hunks as the two sides ACP shows: old = context + removed lines, new = context + added lines. */
export function diffSides(diff: string): { oldText: string; newText: string } {
  const before: string[] = [];
  const after: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@") || line.startsWith("\\")) continue;
    if (line.startsWith("-")) before.push(line.slice(1));
    else if (line.startsWith("+")) after.push(line.slice(1));
    else if (line.startsWith(" ")) { before.push(line.slice(1)); after.push(line.slice(1)); }
  }
  return { oldText: before.join("\n"), newText: after.join("\n") };
}

/** The content a tool call shows: an edit's diffs, else the outcome's excerpt. */
export function toolContent(item: Extract<Item, { type: "action" }>): acp.ToolCallContent[] {
  const { action } = item;
  if (action.kind === "edit") {
    return action.changes.filter((c) => c.diff).map((c) => {
      const { oldText, newText } = diffSides(c.diff!);
      return { type: "diff", path: c.path, oldText: c.change === "add" ? null : oldText, newText };
    });
  }
  return item.outcome?.excerpt ? [{ type: "content", content: { type: "text", text: item.outcome.excerpt } }] : [];
}

/** A bo action item → the full tool call (first seen) or an update (later). */
export function toolCall(item: Extract<Item, { type: "action" }>, first: boolean): acp.SessionUpdate {
  const common = { toolCallId: item.id, status: STATUS[item.status], content: toolContent(item) };
  return first
    ? { sessionUpdate: "tool_call", ...common, title: summary(item.action), kind: toolKind(item.action), locations: locations(item.action), rawInput: item.action }
    : { sessionUpdate: "tool_call_update", ...common, ...(item.outcome ? { rawOutput: item.outcome } : {}) };
}

export function planUpdate(item: Extract<Item, { type: "plan" }>): acp.SessionUpdate {
  return { sessionUpdate: "plan", entries: item.steps.map((s) => ({ content: s.text, status: s.status, priority: "medium" })) };
}

export function text(item: Extract<Item, { type: "message" }>): string {
  return item.content.map((p) => (p.kind === "text" ? p.text : p.kind === "data" ? JSON.stringify(p.data) : "")).join("");
}

export function usage(u: Usage): acp.Usage {
  return { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cachedReadTokens: u.cached_input_tokens, totalTokens: u.input_tokens + u.output_tokens };
}

/** The approval choices bo offers, and the decision each means. */
export const PERMISSION_OPTIONS: readonly (acp.PermissionOption & { decision: "allow" | "allow_for_run" | "deny" })[] = [
  { optionId: "allow", name: "Allow", kind: "allow_once", decision: "allow" },
  { optionId: "allow-run", name: "Allow for this prompt", kind: "allow_always", decision: "allow_for_run" },
  { optionId: "deny", name: "Deny", kind: "reject_once", decision: "deny" },
];

/** A bo question item as an elicitation form: one property per question. */
export function questionForm(item: Extract<Item, { type: "question" }>): { message: string; requestedSchema: acp.ElicitationSchema } {
  const properties: Record<string, acp.ElicitationPropertySchema> = {};
  for (const q of item.questions) {
    properties[q.id] = q.options?.length
      ? q.multiple
        ? { type: "array", title: q.text, items: { type: "string", enum: q.options } }
        : { type: "string", title: q.text, enum: q.options }
      : { type: "string", title: q.text };
  }
  return {
    message: item.questions.length === 1 ? item.questions[0]!.text : "The agent has questions",
    requestedSchema: { type: "object", properties, required: item.questions.map((q) => q.id) },
  };
}

/** Form content → bo answers (every answer a list of strings). */
export function answersFrom(content: Record<string, unknown> | null | undefined): Record<string, string[]> {
  return Object.fromEntries(Object.entries(content ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : [String(v)]]));
}
