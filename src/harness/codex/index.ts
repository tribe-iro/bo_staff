// codex harness: one `codex app-server` process per run, JSON-RPC over stdio.
//
// Live conformance (2026-09-22, codex-cli 0.155.1): C1–C9, C11–C19, C18b, C21–C23 PASS; C10 (questions) and C20
// (plan) pass with the question feature and the plan tool enabled (2026-09-23). Finding folded in: workspace-write also allows /tmp and $TMPDIR by default (C6), so bo
// excludes /tmp and gives each run a private TMPDIR.

import { randomUUID } from "node:crypto";
import { access, mkdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Action, AuthKind, EngineInfo, ModelInfo, Part, Question, Response } from "../../model.ts";
import { stateDir } from "../../paths.ts";
import { VERSION } from "../../version.ts";
import type { ResolvedSpec } from "../../spec.ts";
import { strip } from "../../spec.ts";
import {
  answersFor, authPolicy, engineEnv, execText, isAllow, mapValues, orderedInput, parseVersion, stageSkills, which,
} from "../common.ts";
import { applyOps, errorMessage, failure, ruleKey, type Harness, type NativeTap, type Outcome, type RunIO } from "../port.ts";
import { CodexRpc, RpcError } from "./rpc.ts";
import type {
  AccountResponse, CommandApprovalParams, FileChangeApprovalParams, Model, ModelListResponse, PermissionsApprovalParams,
  SandboxMode, SandboxPolicy, ThreadParams, ThreadResponse, TurnStartResponse, UserInput, UserInputParams,
} from "./protocol.ts";
import { createTranslator, type CodexTranslator } from "./translate.ts";

export interface CodexDeps { command?: string; env?: NodeJS.ProcessEnv; onNative?: NativeTap }

export function classifyCodexAuth(resp: AccountResponse): AuthKind {
  switch (resp.account?.type) {
    case "apiKey": return "api_key";
    case "amazonBedrock": return "cloud_provider";
    case "chatgpt": return "subscription";
    default: return "none";
  }
}

export function codexModels(models: readonly Model[]): ModelInfo[] {
  return models.filter((m) => !m.hidden).map((m) => {
    const id = m.model || m.id;
    return {
      id, aliases: m.id !== id ? [m.id] : [], default: m.isDefault,
      efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort),
      images: m.inputModalities?.includes("image") ?? true,
    };
  });
}

/**
 * App-server launch overrides. Bundled skills, remote plugins and apps (connectors) are operator-account features, not
 * part of a run. The question tool (`request_user_input`) is off outside plan mode unless this feature is on (verified
 * live on 0.155.1). These only take effect as launch flags, not as per-thread config.
 */
export const CODEX_ARGS: readonly string[] = [
  "skills.bundled.enabled=false", "features.apps=false", "features.plugins=false", "features.remote_plugin=false",
  "features.default_mode_request_user_input=true",
].flatMap((kv) => ["-c", kv]);

const SANDBOX: Record<ResolvedSpec["access"], SandboxMode> = {
  read: "read-only", write: "workspace-write", full: "danger-full-access",
};

/**
 * bo's own CODEX_HOME: the operator's `config.toml` (MCP servers, profiles, approval settings) never reaches a run,
 * and codex must not persist config there either (it records project trust), so any `config.toml` is removed.
 * It is persistent because thread resume and fork read rollouts from `sessions/`. Only the login is shared, as a
 * symlink to the operator's `auth.json` (codex writes through it in place), re-pointed atomically (or removed when
 * the operator has none).
 */
export async function prepareCodexHome(env: NodeJS.ProcessEnv): Promise<string> {
  const home = path.join(stateDir(env), "codex");
  await mkdir(home, { recursive: true });
  await rm(path.join(home, "config.toml"), { force: true });
  const source = path.join(env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex"), "auth.json");
  const link = path.join(home, "auth.json");
  if (!(await access(source).then(() => true, () => false))) {
    await rm(link, { force: true });
    return home;
  }
  if (await readlink(link).catch(() => undefined) !== source) {
    const staged = `${link}.${randomUUID()}`;
    await symlink(source, staged);
    await rename(staged, link);
  }
  return home;
}

export function createCodex(deps: CodexDeps = {}): Harness {
  const env = deps.env ?? process.env;
  let command = deps.command;

  return {
    id: "codex",

    async probe(): Promise<EngineInfo> {
      command ??= await which("codex", env.PATH);
      const base: EngineInfo = { id: "codex", available: false, authentication: "none", models: [] };
      if (!command) return { ...base, reason: "`codex` is not on the server's PATH; install the Codex CLI or fix PATH" };
      const version = parseVersion(await execText(command, ["--version"]).catch(() => "")) ?? "unknown";
      let rpc: CodexRpc | undefined;
      try {
        rpc = new CodexRpc(command, CODEX_ARGS, process.cwd(), engineEnv(env, { CODEX_HOME: await prepareCodexHome(env) }));
        await rpc.initialize(VERSION);
        const [models, account] = await Promise.all([
          rpc.request<ModelListResponse>("model/list", {}),
          rpc.request<AccountResponse>("account/read", {}),
        ]);
        const auth = classifyCodexAuth(account);
        const verdict = authPolicy(auth, env);
        return {
          ...base, version, authentication: auth, available: verdict.allowed,
          ...(verdict.allowed ? {} : { reason: verdict.reason }),
          models: codexModels(models.data),
        };
      } catch (err) {
        return { ...base, version, reason: `probe failed: ${errorMessage(err)}` };
      } finally {
        await rpc?.close();
      }
    },

    async run(spec, io) {
      command ??= await which("codex", env.PATH);
      if (!command) return failure("engine_unavailable", "`codex` is not on the server's PATH");
      return runCodex(spec, io, command, env, deps.onNative);
    },
  };
}

async function runCodex(spec: ResolvedSpec, io: RunIO, command: string, env: NodeJS.ProcessEnv, onNative?: NativeTap): Promise<Outcome> {
  const translator = createTranslator(spec);
  // bo's `write` means workspace + extra roots only: Codex would otherwise also allow /tmp and $TMPDIR, so the run
  // gets a private TMPDIR (inside bo's per-run dir) as its only extra scratch space.
  const privateTmp = path.join(io.tmpDir, "tmp");
  await mkdir(privateTmp, { recursive: true });
  const rpc = new CodexRpc(command, CODEX_ARGS, spec.root, engineEnv(env, { ...spec.env, TMPDIR: privateTmp, CODEX_HOME: await prepareCodexHome(env) }));
  let threadId = "";
  let turnId = "";
  const turnDone = Promise.withResolvers<void>();

  rpc.onNotification = (method, params) => {
    onNative?.({ method, params });
    applyOps(io, translator.onNotification(method, params));
    // `translator.turn` is set only for the main thread's turn. Matching on it rather than the turn id avoids a race:
    // `turn/completed` can arrive in the same chunk as the `turn/start` response, before `turnId` is assigned.
    if (method === "turn/completed" && translator.turn) turnDone.resolve();
  };
  rpc.onRequest = (method, params) => serverRequest(method, params, spec, io, translator);
  void rpc.exited.then(() => turnDone.resolve());

  const onAbort = (): void => {
    if (threadId && turnId) void rpc.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
    void rpc.close();
  };
  if (io.signal.aborted) onAbort();
  else io.signal.addEventListener("abort", onAbort, { once: true });

  try {
    await rpc.initialize(VERSION);
    const verdict = authPolicy(classifyCodexAuth(await rpc.request<AccountResponse>("account/read", {})), env);
    if (!verdict.allowed) return failure("auth_failed", verdict.reason);

    if (spec.skills.length) {
      await rpc.request("skills/extraRoots/set", { extraRoots: [await stageSkills(spec.skills, path.join(io.tmpDir, "skills"))] });
    }
    const common: ThreadParams = strip({
      cwd: spec.root,
      model: spec.model,
      sandbox: SANDBOX[spec.access],
      approvalPolicy: spec.interactive ? "on-request" : "never",
      developerInstructions: spec.instructions,
      config: strip({
        // Untrusted: codex neither records trust in CODEX_HOME nor loads the workspace's `.codex/` layer (config, MCP
        // servers, hooks) or AGENTS.md; project instructions reach the run only through `instructions` (resolveSpec).
        projects: Object.fromEntries([spec.root, ...spec.extraRoots].map((root) => [root, { trust_level: "untrusted" }])),
        web_search: spec.internet ? undefined : "disabled",
        // The plan tool (`update_plan` → `turn/plan/updated`) is off unless enabled.
        tools: { update_plan: { enabled: true } },
        model_reasoning_summary: "auto",
        mcp_servers: Object.keys(spec.mcp).length ? mapValues(spec.mcp, (s) => strip({
          ...("command" in s ? { command: s.command, args: s.args, env: s.env } : { url: s.url, http_headers: s.headers }),
          default_tools_approval_mode: "approve",
          enabled_tools: s.tools,
        })) : undefined,
        agents: Object.keys(spec.subagents).length ? await roleFiles(spec, io.tmpDir) : undefined,
      }),
    });
    const t = !spec.session
      ? await rpc.request<ThreadResponse>("thread/start", common)
      : spec.session.fork
        ? await rpc.request<ThreadResponse>("thread/fork", { threadId: spec.session.native, ephemeral: false, ...common })
        : await rpc.request<ThreadResponse>("thread/resume", { threadId: spec.session.native, ...common });
    threadId = t.thread.id;
    onNative?.({ threadId });
    translator.setMainThread(threadId);
    io.session(threadId);
    io.model(t.model);

    const sandboxPolicy: SandboxPolicy = spec.access === "read" ? { type: "readOnly", networkAccess: spec.internet }
      : spec.access === "write" ? { type: "workspaceWrite", writableRoots: [...spec.extraRoots, privateTmp], networkAccess: spec.internet, excludeSlashTmp: true, excludeTmpdirEnvVar: false }
        : { type: "dangerFullAccess" };
    const turn = await rpc.request<TurnStartResponse>("turn/start", strip({
      threadId, input: codexInput(spec.input), effort: spec.effort, outputSchema: spec.schema, sandboxPolicy,
    }));
    turnId = turn.turn.id;
    if (io.signal.aborted) onAbort();

    io.accept(true);
    // Steering pump: every message is settled exactly once, and nothing here can reject.
    void (async () => {
      for await (const steer of io.messages) {
        if (translator.turn) { steer.dropped("the turn has completed"); continue; }
        try {
          await rpc.request("turn/steer", { threadId, expectedTurnId: turnId, input: codexInput(steer.parts) });
          steer.delivered();
        } catch (err) {
          steer.dropped(errorMessage(err));
        }
      }
    })();

    await turnDone.promise;
    io.accept(false);
    const outcome = translator.outcome();
    return outcome.ok ? outcome : { ...outcome, diagnostic: { provider: outcome.diagnostic, stderr: rpc.stderrTail(2000) } };
  } catch (err) {
    return failure("engine_error", "Codex execution failed", translator.outcome().usage, err);
  } finally {
    io.accept(false);
    io.signal.removeEventListener("abort", onAbort);
    await rpc.close();
  }
}

function codexInput(parts: readonly Part[]): UserInput[] {
  return orderedInput(parts).map((part): UserInput => part.kind === "text"
    ? { type: "text", text: part.text }
    : { type: "localImage", path: part.path });
}

/**
 * Answers app-server requests. bo's `allowedForRun` is the only run-wide approval memory, so Codex is only ever
 * told `accept` or `decline` for this one request, never a session-wide grant.
 */
export async function serverRequest(
  method: string, params: Record<string, unknown>, spec: ResolvedSpec, io: RunIO, translator: Pick<CodexTranslator, "parentOf" | "actionOf">,
): Promise<unknown> {
  const parentKey = translator.parentOf(String(params.threadId ?? ""));
  const decide = async (key: string, action: Action, reason: string | null | undefined): Promise<Response | undefined> => {
    if (io.allowedForRun.has(ruleKey(action))) return { decision: "allow" };
    if (!spec.interactive) return { decision: "deny" };
    return io.await(key, { type: "action", action, status: "awaiting_approval", ...(reason ? { reason } : {}) }, parentKey);
  };
  const decision = (r: Response | undefined) => (isAllow(r) ? "accept" : "decline");

  switch (method) {
    case "item/commandExecution/requestApproval": {
      const p = params as unknown as CommandApprovalParams;
      return { decision: decision(await decide(p.itemId, { kind: "shell", command: p.command ?? "" }, p.reason)) };
    }
    case "item/fileChange/requestApproval": {
      const p = params as unknown as FileChangeApprovalParams;
      const action = translator.actionOf(p.itemId) ?? { kind: "edit", changes: [] };
      return { decision: decision(await decide(p.itemId, action, p.reason)) };
    }
    case "item/permissions/requestApproval": {
      const p = params as unknown as PermissionsApprovalParams;
      const r = await decide(p.itemId, { kind: "other", name: "permissions" }, p.reason ?? "additional permissions");
      return isAllow(r) ? { permissions: p.permissions, scope: "turn" } : { permissions: {} };
    }
    case "item/tool/requestUserInput": {
      const p = params as unknown as UserInputParams;
      const questions: Question[] = p.questions.map((q) => ({
        id: q.id, text: q.question, multiple: false,
        ...(q.options?.length ? { options: q.options.map((o) => o.label) } : {}),
      }));
      const r = spec.interactive ? await io.await(p.itemId, { type: "question", questions, status: "awaiting_answer" }, parentKey) : undefined;
      return { answers: mapValues(r && "answers" in r ? answersFor(questions, r) : {}, (a) => ({ answers: a })) };
    }
    case "mcpServer/elicitation/request":
      return { action: "decline" };
  }
  throw new RpcError(`unsupported server request: ${method}`, -32601);
}

async function roleFiles(spec: ResolvedSpec, tmpDir: string): Promise<Record<string, { description: string; config_file: string }>> {
  const dir = path.join(tmpDir, "agents");
  await mkdir(dir, { recursive: true });
  const out: Record<string, { description: string; config_file: string }> = {};
  for (const [name, a] of Object.entries(spec.subagents)) {
    const file = path.join(dir, `${name}.toml`);
    const lines = [
      `developer_instructions = ${JSON.stringify(a.instructions)}`,
      ...(a.model ? [`model = ${JSON.stringify(a.model)}`] : []),
      ...(a.effort ? [`model_reasoning_effort = ${JSON.stringify(a.effort)}`] : []),
    ];
    // JSON string literals are valid TOML basic strings.
    await writeFile(file, `${lines.join("\n")}\n`);
    out[name] = { description: a.description, config_file: file };
  }
  return out;
}
