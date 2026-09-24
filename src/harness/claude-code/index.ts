// claude-code harness: Claude Agent SDK (streaming-input query) driving the local `claude` CLI.
//
// Live conformance (2026-09-22, Claude Code 2.1.280, SDK 0.3.280): C1–C23 and C18b PASS.
// Findings folded into this adapter: sandboxed Bash with shell expansion still reaches canUseTool (C11) and is allowed;
// task tracking needs TaskCreate/TaskUpdate opted in via allowedTools (C20); thinking text needs display "summarized" (C21).

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  query as sdkQuery,
  type AccountInfo, type AgentDefinition, type CanUseTool, type ModelInfo as SdkModelInfo, type Options, type PermissionResult, type Query,
  type SDKUserMessage, type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { AuthKind, EngineInfo, ModelInfo, Part, Question } from "../../model.ts";
import { strip, type ResolvedSpec } from "../../spec.ts";
import { AsyncQueue } from "../../core/queue.ts";
import {
  answersFor, authPolicy, engineEnv, execText, isAllow, mapValues, orderedInput, parseVersion,
  spawnInGroup, stageSkills, TailBuffer, terminateProcessGroup, which, withTimeout,
} from "../common.ts";
import {
  applyOps, errorMessage, failure, ruleKey, ZERO_USAGE, type Harness, type NativeTap, type Outcome, type RunIO,
} from "../port.ts";
import { createTranslator, QUESTION_TOOL, TASK_TOOLS, toAction, type ClaudeTranslator } from "./translate.ts";

/**
 * The SDK warns that allowedTools entries bypass canUseTool. For the task tools that is the intent: they only update
 * the agent's own plan, and Claude Code offers them only when listed in allowedTools (verified live).
 */
export const EXPECTED_WARNINGS: ReadonlySet<string> = new Set(["CLAUDE_SDK_CAN_USE_TOOL_SHADOWED"]);


const NO_USER = "No user is available. Proceed with your best judgment.";

export type QueryFn = typeof sdkQuery;

export interface ClaudeDeps {
  query?: QueryFn;
  claudePath?: string;
  env?: NodeJS.ProcessEnv;
  onNative?: NativeTap;
}

type UserContent = SDKUserMessage["message"]["content"];

export function classifyClaudeAuth(env: NodeJS.ProcessEnv, info: AccountInfo): AuthKind {
  if (env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX || env.CLAUDE_CODE_USE_FOUNDRY) return "cloud_provider";
  if (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY) return "api_key";
  if (info.apiProvider && info.apiProvider !== "firstParty") return info.apiProvider === "gateway" ? "api_key" : "cloud_provider";
  if (info.subscriptionType) return "subscription";
  if (info.apiKeySource && info.apiKeySource !== "none") return "api_key";
  return "none";
}

/** SDK model rows are aliases (`default`, `opus`, …); rows resolving to the same wire id collapse into one model. */
export function claudeModels(rows: readonly SdkModelInfo[]): ModelInfo[] {
  const byId = new Map<string, ModelInfo>();
  for (const row of rows) {
    const id = row.resolvedModel ?? row.value;
    const model = byId.get(id) ?? { id, aliases: [], default: false, efforts: [], images: true };
    if (row.value !== id && !model.aliases.includes(row.value)) model.aliases.push(row.value);
    model.default ||= row.value === "default";
    for (const effort of row.supportsEffort === false ? [] : row.supportedEffortLevels ?? []) {
      if (!model.efforts.includes(effort)) model.efforts.push(effort);
    }
    byId.set(id, model);
  }
  return [...byId.values()];
}

export function createClaudeCode(deps: ClaudeDeps = {}): Harness {
  const query = deps.query ?? sdkQuery;
  const env = deps.env ?? process.env;
  let claudePath = deps.claudePath;

  return {
    id: "claude-code",

    async probe(): Promise<EngineInfo> {
      claudePath ??= await which("claude", env.PATH);
      const base: EngineInfo = { id: "claude-code", available: false, authentication: "none", models: [] };
      if (!claudePath) return { ...base, reason: "`claude` is not on the server's PATH; install Claude Code or fix PATH" };
      const version = parseVersion(await execText(claudePath, ["--version"]).catch(() => "")) ?? "unknown";
      const input = new AsyncQueue<SDKUserMessage>();
      const q = query({ prompt: input, options: { pathToClaudeCodeExecutable: claudePath, env: engineEnv(env), settingSources: [] } });
      try {
        const [models, account] = await withTimeout(Promise.all([q.supportedModels(), q.accountInfo()]), 10_000);
        const auth = classifyClaudeAuth(env, account);
        const policy = authPolicy(auth, env);
        return {
          ...base, version, authentication: auth,
          available: policy.allowed,
          ...(policy.allowed ? {} : { reason: policy.reason }),
          models: claudeModels(models),
        };
      } catch (err) {
        return { ...base, version, reason: `probe failed: ${errorMessage(err)}` };
      } finally {
        input.close();
        q.close();
      }
    },

    async run(spec, io) {
      claudePath ??= await which("claude", env.PATH);
      if (!claudePath) return failure("engine_unavailable", "`claude` is not on the server's PATH");
      return runClaude(spec, io, { query, claudePath, env, onNative: deps.onNative });
    },
  };
}

async function runClaude(
  spec: ResolvedSpec, io: RunIO, deps: { query: QueryFn; claudePath: string; env: NodeJS.ProcessEnv; onNative?: NativeTap },
): Promise<Outcome> {
  const { env, onNative } = deps;
  const translator = createTranslator(spec);
  const input = new AsyncQueue<SDKUserMessage>();
  const outstanding = new Set<string>();
  const abortController = new AbortController();
  let child: ReturnType<typeof spawnInGroup> | undefined;
  const stderr = new TailBuffer();
  let q: Query | undefined;
  let refused: string | undefined;
  let termination: Promise<void> | undefined;

  /** Queues a user message; false when the input already closed (the message never reaches the engine). */
  const send = (content: UserContent): boolean => {
    const uuid = randomUUID();
    if (!input.push({ type: "user", uuid, parent_tool_use_id: null, message: { role: "user", content } })) return false;
    outstanding.add(uuid);
    return true;
  };

  const options: Options = {
    cwd: spec.root,
    pathToClaudeCodeExecutable: deps.claudePath,
    env: engineEnv(env, spec.env),
    // Hermetic: the operator's settings (allow-rules, hooks, MCP servers, plugins), claude.ai connectors, bundled
    // skills and auto-memory (~/.claude/projects/<dir>/memory, on by default) never reach a run; only the spec does.
    settingSources: [],
    strictMcpConfig: true,
    settings: { disableBundledSkills: true, autoMemoryEnabled: false },
    model: spec.model,
    effort: spec.effort as Options["effort"],
    resume: spec.session?.native,
    forkSession: spec.session?.fork ?? false,
    systemPrompt: { type: "preset", preset: "claude_code", ...(spec.instructions ? { append: spec.instructions } : {}) },
    ...(spec.schema ? { outputFormat: { type: "json_schema", schema: spec.schema } } : {}),
    mcpServers: mapValues(spec.mcp, (s) => ("command" in s
      ? { type: "stdio" as const, command: s.command, ...(s.args ? { args: s.args } : {}), ...(s.env ? { env: s.env } : {}) }
      : { type: "http" as const, url: s.url, ...(s.headers ? { headers: s.headers } : {}) })),
    disallowedTools: spec.internet ? [] : ["WebFetch", "WebSearch"],
    allowedTools: [...TASK_TOOLS],
    additionalDirectories: spec.extraRoots,
    plugins: spec.skills.length ? [{ type: "local", path: await skillsPlugin(spec, io.tmpDir) }] : [],
    agents: mapValues(spec.subagents, (a) => strip({
      description: a.description, prompt: a.instructions, model: a.model, effort: a.effort as AgentDefinition["effort"],
    })),
    thinking: { type: "adaptive", display: "summarized" },
    includePartialMessages: true,
    forwardSubagentText: true,
    abortController,
    permissionMode: spec.access === "write" ? "acceptEdits" : "default",
    ...(spec.access === "full" ? {} : { sandbox: sandboxFor(spec) }),
    canUseTool: policyFor(spec, io, translator),
    spawnClaudeCodeProcess: (o: SpawnOptions) => {
      child = spawnInGroup(o.command, o.args, { cwd: o.cwd, env: o.env });
      o.signal?.addEventListener("abort", () => { if (child) void terminateProcessGroup(child); }, { once: true });
      child.stderr?.on("data", (c: Buffer) => stderr.append(c));
      return child as unknown as ReturnType<NonNullable<Options["spawnClaudeCodeProcess"]>>;
    },
  };

  const content = await claudeInput(spec.input);
  q = deps.query({ prompt: input, options });

  // Auth gate before any model request: the first user message is only sent once the account is acceptable.
  const gate = q.accountInfo().then((info) => {
    const verdict = authPolicy(classifyClaudeAuth(env, info), env);
    if (verdict.allowed) {
      send(content);
      io.accept(true);
    } else {
      refused = verdict.reason;
      input.close();
    }
  }, (err: unknown) => {
    refused = `account check failed: ${errorMessage(err)}`;
    input.close();
  });

  // Steering pump: every message is settled exactly once, and nothing here can reject.
  void (async () => {
    for await (const steer of io.messages) {
      try {
        if (!input.isClosed && send(await claudeInput(steer.parts))) steer.delivered();
        else steer.dropped("the run is finishing");
      } catch (err) {
        steer.dropped(errorMessage(err));
      }
    }
  })();

  const onAbort = (): void => {
    input.close();
    const interrupt = () => { void q?.interrupt().catch(() => undefined); abortController.abort(); };
    termination = child ? terminateProcessGroup(child, interrupt) : Promise.resolve(interrupt());
  };
  if (io.signal.aborted) onAbort();
  else io.signal.addEventListener("abort", onAbort, { once: true });

  try {
    for await (const m of q) {
      onNative?.({ message: m });
      applyOps(io, translator.onMessage(m));
      if (m.type === "result") {
        for (const uuid of m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : [])) outstanding.delete(uuid);
        // Done only when no sent message awaits its turn, none is queued, and no background task (e.g. a backgrounded
        // subagent) still runs: its completion comes back as another turn and another result.
        if (outstanding.size === 0 && (m.queued_turn_count ?? 0) === 0 && !translator.busy) {
          io.accept(false);
          input.close();
        }
      }
    }
  } catch (err) {
    // The CLI exits non-zero after some terminal results (e.g. the turn limit); a classified result outranks the exit.
    const outcome = translator.outcome();
    if (!io.signal.aborted && !outcome.ok && outcome.error.code !== "engine_error") return outcome;
    if (!io.signal.aborted) {
      return { ...failure("engine_error", "Claude execution failed", outcome.usage, { error: err, stderr: stderr.toString() }), ...(outcome.totals ? { totals: outcome.totals } : {}) };
    }
  } finally {
    io.signal.removeEventListener("abort", onAbort);
    io.accept(false);
    input.close();
    if (child) termination ??= terminateProcessGroup(child);
    await termination;
    await gate;
  }
  if (refused) return failure("auth_failed", refused, ZERO_USAGE);
  const outcome = translator.outcome();
  return outcome.ok ? outcome : { ...outcome, diagnostic: { provider: outcome.diagnostic, stderr: stderr.toString() } };
}

async function claudeInput(parts: readonly Part[]): Promise<UserContent> {
  const content = await Promise.all(orderedInput(parts).map(async (part) => part.kind === "text"
    ? { type: "text" as const, text: part.text }
    : {
        type: "image" as const,
        source: { type: "base64" as const, media_type: part.mediaType as "image/png", data: (await readFile(part.path)).toString("base64") },
      }));
  return content.length === 1 && content[0]?.type === "text" ? content[0].text : content;
}

export function policyFor(spec: ResolvedSpec, io: RunIO, translator: Pick<ClaudeTranslator, "denied">): CanUseTool {
  const allow = (input: Record<string, unknown>): PermissionResult => ({ behavior: "allow", updatedInput: input });
  return async (toolName, input, { toolUseID, decisionReason }) => {
    if (toolName === QUESTION_TOOL) {
      if (!spec.interactive) return { behavior: "deny", message: NO_USER };
      const raw = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : [];
      const questions: Question[] = raw.map((q, i) => ({
        id: String(i),
        text: String(q.question ?? ""),
        ...(Array.isArray(q.options) ? { options: (q.options as { label?: unknown }[]).map((o) => String(o.label ?? "")) } : {}),
        multiple: q.multiSelect === true,
      }));
      const r = await io.await(toolUseID, { type: "question", questions, status: "awaiting_answer" });
      if (!r || !("answers" in r)) return { behavior: "deny", message: NO_USER };
      const answers = answersFor(questions, r);
      return allow({ ...input, answers: Object.fromEntries(questions.map((q) => [q.text, answers[q.id]!.join(", ")])) });
    }

    const action = toAction(toolName, input);
    if (action.kind === "mcp") {
      const tools = spec.mcp[action.server]?.tools;
      if (tools && !tools.includes(action.tool)) return deny(toolUseID, action, "tool not permitted");
      if (spec.mcp[action.server]) return allow(input);
    }
    // With internet off the web tools are removed entirely (disallowedTools), so reaching here means it is on.
    if (action.kind === "web" && spec.internet) return allow(input);
    if (spec.access === "full" || io.allowedForRun.has(ruleKey(action))) return allow(input);
    // read/write run Bash inside the OS sandbox; a command that stays sandboxed is already confined to the access level.
    if (toolName === "Bash" && input.dangerouslyDisableSandbox !== true) return allow(input);
    if (!spec.interactive) return deny(toolUseID, action, `not permitted by access level ${spec.access}`);

    const r = await io.await(toolUseID, {
      type: "action", action, status: "awaiting_approval", ...(decisionReason ? { reason: decisionReason } : {}),
    });
    return isAllow(r) ? allow(input) : { behavior: "deny", message: "denied by caller" };
  };

  function deny(key: string, action: ReturnType<typeof toAction>, message: string): PermissionResult {
    translator.denied.add(key);
    io.upsert(key, { type: "action", action, status: "denied", reason: message });
    return { behavior: "deny", message };
  }
}

function sandboxFor(spec: ResolvedSpec): NonNullable<Options["sandbox"]> {
  return {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    failIfUnavailable: true,
    filesystem: spec.access === "read" ? { denyWrite: [spec.root, ...spec.extraRoots] } : { allowWrite: spec.extraRoots },
    network: spec.internet ? { allowedDomains: ["*"] } : { allowedDomains: [], strictAllowlist: true },
  };
}

async function skillsPlugin(spec: ResolvedSpec, tmpDir: string): Promise<string> {
  const root = path.join(tmpDir, "skills-plugin");
  await mkdir(path.join(root, ".claude-plugin"), { recursive: true });
  await writeFile(path.join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "bo-skills", version: "0.0.0", description: "skills attached by bo" }));
  await stageSkills(spec.skills, path.join(root, "skills"));
  return root;
}
