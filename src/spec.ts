import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Ajv, type ValidateFunction } from "ajv/dist/ajv.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { decodeSession, mint } from "./ids.ts";
import {
  ACCESS_LEVELS, ENGINE_IDS, IMAGE_MEDIA_TYPES,
  type Access, type EngineId, type EngineInfo, type ImageMediaType,
  type McpServer, type ModelInfo, type Part, type Response, type Subagent,
} from "./model.ts";
import { problem, type FieldError, type Problem } from "./problems.ts";
import type { SessionLookup } from "./core/sessions.ts";

export interface ResolvedSpec {
  runId: string;
  engine: EngineId;
  input: Part[];
  root: string;
  extraRoots: string[];
  /** Canonical model id (aliases are resolved). */
  model?: string;
  effort?: string;
  /** Workspace instruction files (when requested), then the caller's instructions. */
  instructions?: string;
  skills: { name: string; path: string }[];
  mcp: Record<string, McpServer>;
  subagents: Record<string, Subagent>;
  access: Access;
  internet: boolean;
  interactive: boolean;
  /** The run's model accepts image input (in the prompt and in later messages). */
  images: boolean;
  env: Record<string, string>;
  limits: { maxTurns?: number; maxTokens?: number };
  schema?: Record<string, unknown>;
  validateOutput?: ValidateFunction;
  session?: { native: string; fork: boolean };
  timeoutMs: number;
}

/** What spec resolution needs to know about engines. */
export interface EngineCatalog {
  info(id: EngineId): Promise<EngineInfo | undefined>;
  defaultEngine(): Promise<EngineId | undefined>;
}

type Obj = Record<string, unknown>;

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_DATA_CHARS = 262_144;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_PROJECT_DOC_BYTES = 32 * 1024;
/** Workspace instruction files, in the order they are included. */
const PROJECT_DOCS = ["AGENTS.md", "CLAUDE.md"];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MCP_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const SLUG = /^[a-z0-9-]{1,64}$/;
const DRAFT_07 = new Set(["http://json-schema.org/draft-07/schema#", "https://json-schema.org/draft-07/schema#"]);

// One compiler for the process. Compiled validators are self-contained, so each schema is evicted from Ajv's
// identity-keyed cache right after compilation instead of accumulating one entry per request.
const ajv = new Ajv({ strict: true, allErrors: true, validateSchema: true, formats: fullFormats });

/**
 * Single-pass checker: every accessor validates, records a JSON-Pointer error on failure, and
 * returns the typed value (or undefined). Nothing is validated twice.
 */
export class Checker {
  readonly errors: FieldError[] = [];

  fail(pointer: string, detail: string): undefined {
    this.errors.push({ pointer, detail });
    return undefined;
  }

  object(v: unknown, ptr: string, keys: readonly string[]): Obj | undefined {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return this.fail(ptr || "/", "must be an object");
    for (const k of Object.keys(v)) if (!keys.includes(k)) this.fail(`${ptr}/${escape(k)}`, "unknown field");
    return v as Obj;
  }

  record(v: unknown, ptr: string, maxEntries: number, keyPattern: RegExp): Obj | undefined {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return this.fail(ptr, "must be an object");
    const entries = Object.keys(v);
    if (entries.length > maxEntries) return this.fail(ptr, `at most ${maxEntries} entries`);
    for (const k of entries) if (!keyPattern.test(k)) this.fail(`${ptr}/${escape(k)}`, `key must match ${keyPattern.source}`);
    return v as Obj;
  }

  array(v: unknown, ptr: string, min: number, max: number): unknown[] | undefined {
    if (!Array.isArray(v)) return this.fail(ptr, "must be an array");
    if (v.length < min || v.length > max) return this.fail(ptr, `must have ${min}–${max} entries`);
    return v;
  }

  text(v: unknown, ptr: string): string | undefined {
    if (typeof v !== "string" || v.trim() === "") return this.fail(ptr, "must be a non-empty string");
    return v;
  }

  strings(v: unknown, ptr: string): string[] | undefined {
    if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) return this.fail(ptr, "must be an array of strings");
    return v as string[];
  }

  stringMap(v: unknown, ptr: string): Record<string, string> | undefined {
    if (typeof v !== "object" || v === null || Array.isArray(v) || Object.values(v).some((s) => typeof s !== "string")) {
      return this.fail(ptr, "must map strings to strings");
    }
    return v as Record<string, string>;
  }

  bool(v: unknown, ptr: string): boolean | undefined {
    if (typeof v !== "boolean") return this.fail(ptr, "must be a boolean");
    return v;
  }

  int(v: unknown, ptr: string, min: number, max: number): number | undefined {
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return this.fail(ptr, `must be an integer ${min}–${max}`);
    return v;
  }

  oneOf<T extends string>(v: unknown, ptr: string, values: readonly T[]): T | undefined {
    if (typeof v !== "string" || !values.includes(v as T)) return this.fail(ptr, `must be one of ${values.join(", ")}`);
    return v as T;
  }

  absolute(v: unknown, ptr: string): string | undefined {
    const s = this.text(v, ptr);
    if (s === undefined) return undefined;
    if (!path.isAbsolute(s)) return this.fail(ptr, "must be an absolute path");
    return s;
  }

  async directory(v: unknown, ptr: string): Promise<string | undefined> {
    const p = this.absolute(v, ptr);
    if (p === undefined) return undefined;
    try {
      const real = await realpath(p);
      if (!(await stat(real)).isDirectory()) return this.fail(ptr, "must be a directory");
      return real;
    } catch {
      return this.fail(ptr, "must exist");
    }
  }

  /** An object mapping arbitrary keys to string arrays. */
  stringLists(v: unknown, ptr: string): Record<string, string[]> | undefined {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return this.fail(ptr, "must be an object");
    const before = this.errors.length;
    for (const [k, list] of Object.entries(v)) this.strings(list, `${ptr}/${escape(k)}`);
    return this.errors.length === before ? v as Record<string, string[]> : undefined;
  }

  async parts(v: unknown, ptr: string): Promise<Part[] | undefined> {
    const list = this.array(v, ptr, 1, 64);
    if (!list) return undefined;
    const out: Part[] = [];
    for (const [i, raw] of list.entries()) {
      const p = `${ptr}/${i}`;
      const kind = (raw as Obj | null)?.kind;
      if (kind === "text") {
        const o = this.object(raw, p, ["kind", "text"]);
        const text = o && this.text(o.text, `${p}/text`);
        if (text !== undefined) out.push({ kind, text });
      } else if (kind === "image") {
        const o = this.object(raw, p, ["kind", "path", "media_type"]);
        if (!o) continue;
        const media = this.oneOf<ImageMediaType>(o.media_type, `${p}/media_type`, IMAGE_MEDIA_TYPES);
        const file = this.absolute(o.path, `${p}/path`);
        if (file === undefined || media === undefined) continue;
        try {
          const s = await stat(file);
          if (!s.isFile()) this.fail(`${p}/path`, "must be a file");
          else if (s.size > MAX_FILE_BYTES) this.fail(`${p}/path`, "must be at most 5 MiB");
          else out.push({ kind, path: file, media_type: media });
        } catch {
          this.fail(`${p}/path`, "must exist");
        }
      } else if (kind === "data") {
        const o = this.object(raw, p, ["kind", "data"]);
        if (!o) continue;
        if (!("data" in o)) this.fail(`${p}/data`, "is required");
        else if ((JSON.stringify(o.data) ?? "").length > MAX_DATA_CHARS) this.fail(`${p}/data`, "must serialize to at most 262144 characters");
        else out.push({ kind, data: o.data });
      } else {
        this.fail(`${p}/kind`, "must be one of text, image, data");
      }
    }
    return out;
  }
}

/** `sessions` answers `session.latest`; without it, no earlier session exists. */
export async function resolveSpec(
  body: unknown, engines: EngineCatalog, sessions?: SessionLookup,
): Promise<{ spec: ResolvedSpec } | { problem: Problem }> {
  const c = new Checker();
  const root = c.object(body, "", [
    "input", "workspace", "engine", "model", "effort", "instructions", "project_instructions", "skills", "mcp", "subagents",
    "permissions", "interactive", "env", "limits", "output", "session", "timeout_s",
  ]);
  if (!root) return invalid(c);

  const input = await c.parts(root.input, "/input");

  const ws = c.object(root.workspace, "/workspace", ["root", "extra_roots"]);
  const workspaceRoot = ws ? await c.directory(ws.root, "/workspace/root") : undefined;
  const extraRoots: string[] = [];
  if (ws?.extra_roots !== undefined) {
    const list = c.array(ws.extra_roots, "/workspace/extra_roots", 0, 16) ?? [];
    for (const [i, raw] of list.entries()) {
      const ptr = `/workspace/extra_roots/${i}`;
      const dir = await c.directory(raw, ptr);
      if (dir === undefined || workspaceRoot === undefined) continue;
      if (dir === workspaceRoot || isInside(workspaceRoot, dir)) c.fail(ptr, "must not be the workspace root or inside it");
      else extraRoots.push(dir);
    }
  }

  const explicitEngine = root.engine === undefined ? undefined : c.oneOf(root.engine, "/engine", ENGINE_IDS);
  const model = root.model === undefined ? undefined : c.text(root.model, "/model");
  const effort = root.effort === undefined ? undefined : c.text(root.effort, "/effort");
  const callerInstructions = root.instructions === undefined ? undefined : c.text(root.instructions, "/instructions");
  const projectInstructions = root.project_instructions === undefined ? true : c.bool(root.project_instructions, "/project_instructions") ?? true;
  const projectDocs = projectInstructions && workspaceRoot ? await readProjectDocs(c, workspaceRoot) : [];
  const instructions = [...projectDocs, ...(callerInstructions === undefined ? [] : [callerInstructions])].join("\n\n") || undefined;
  const skills = root.skills === undefined ? [] : await resolveSkills(c, root.skills);
  const mcp = root.mcp === undefined ? {} : resolveMcp(c, root.mcp);
  const subagents = root.subagents === undefined ? {} : resolveSubagents(c, root.subagents);

  const perms = root.permissions === undefined ? {} : c.object(root.permissions, "/permissions", ["access", "internet"]) ?? {};
  const access: Access = perms.access === undefined ? "write" : c.oneOf(perms.access, "/permissions/access", ACCESS_LEVELS) ?? "write";
  let internet = access === "full";
  if (perms.internet !== undefined) {
    const v = c.bool(perms.internet, "/permissions/internet");
    if (v === false && access === "full") c.fail("/permissions/internet", "cannot be false with access full");
    else if (v !== undefined) internet = v;
  }

  const interactive = root.interactive === undefined ? false : c.bool(root.interactive, "/interactive") ?? false;
  const env = root.env === undefined ? {} : resolveEnv(c, root.env);
  const limits = root.limits === undefined ? {} : resolveLimits(c, root.limits);
  const output = root.output === undefined ? undefined : resolveOutput(c, root.output);

  let session: ResolvedSpec["session"];
  let sessionEngine: EngineId | undefined;
  if (root.session !== undefined) {
    const s = c.object(root.session, "/session", ["id", "latest", "fork"]);
    if (s && ("id" in s) === ("latest" in s)) c.fail("/session", "must have exactly one of id or latest");
    else if (s) {
      const fork = s.fork === undefined ? false : c.bool(s.fork, "/session/fork") ?? false;
      let id: unknown = s.id;
      if ("latest" in s) {
        if (s.latest !== true) c.fail("/session/latest", "must be true");
        else if (workspaceRoot) {
          id = sessions?.latest({ workspace: workspaceRoot, engine: explicitEngine })?.id;
          if (id === undefined) c.fail("/session/latest", `no earlier session in ${workspaceRoot}${explicitEngine ? ` for ${explicitEngine}` : ""}`);
        }
      }
      const decoded = typeof id === "string" ? decodeSession(id) : null;
      if (decoded) {
        session = { native: decoded.native, fork };
        sessionEngine = decoded.engine;
      } else if ("id" in s) c.fail("/session/id", "must be a session id issued by bo");
    }
  }
  if (sessionEngine && explicitEngine && sessionEngine !== explicitEngine) {
    c.fail("/engine", `conflicts with the session's engine ${sessionEngine}`);
  }
  const engine = sessionEngine ?? explicitEngine ?? await engines.defaultEngine();
  if (!engine) c.fail("/engine", "no engine available");

  let timeoutS = 1800;
  if (root.timeout_s !== undefined) timeoutS = c.int(root.timeout_s, "/timeout_s", 1, 86_400) ?? timeoutS;

  if (c.errors.length || !input || !workspaceRoot || !engine) return invalid(c);

  const info = await engines.info(engine);
  if (!info?.available) {
    return { problem: problem("engine_unavailable", `${engine} is unavailable${info?.reason ? `: ${info.reason}` : ""}`) };
  }

  const models = new ModelResolver(info);
  const selected = model === undefined ? undefined : models.resolve(c, model, "/model");
  const runModel = selected ?? models.fallback;
  if (effort !== undefined) models.checkEffort(c, runModel, effort, "/effort");
  for (const [name, agent] of Object.entries(subagents)) {
    const ptr = `/subagents/${escape(name)}`;
    const agentModel = agent.model === undefined ? runModel : models.resolve(c, agent.model, `${ptr}/model`);
    if (agentModel && agent.model !== undefined) agent.model = agentModel.id;
    if (agent.effort !== undefined) models.checkEffort(c, agentModel, agent.effort, `${ptr}/effort`);
  }
  if (c.errors.length) return invalid(c);
  if (runModel?.images === false && input.some((p) => p.kind === "image")) {
    return { problem: problem("unsupported_feature", `${runModel.id} does not accept images`) };
  }

  return {
    spec: {
      runId: mint("run"), engine, input, root: workspaceRoot, extraRoots,
      model: selected?.id, effort, instructions, skills, mcp, subagents,
      access, internet, interactive, images: runModel?.images ?? true, env, limits, schema: output?.schema, validateOutput: output?.validate, session,
      timeoutMs: timeoutS * 1000,
    },
  };
}

/** Resolves model ids and aliases against a probed engine; an engine that lists no models accepts any. */
class ModelResolver {
  private readonly byName = new Map<string, ModelInfo>();
  private readonly engine: EngineId;
  private readonly open: boolean;
  /** The model a run gets when `model` is omitted. */
  readonly fallback: ModelInfo | undefined;

  constructor(info: EngineInfo) {
    for (const m of info.models) for (const name of [m.id, ...m.aliases]) this.byName.set(name, m);
    this.engine = info.id;
    this.open = info.models.length === 0;
    this.fallback = info.models.find((m) => m.default);
  }

  resolve(c: Checker, name: string, ptr: string): ModelInfo | undefined {
    if (this.open) return { id: name, aliases: [], default: false, efforts: [], images: true };
    const found = this.byName.get(name);
    if (!found) c.fail(ptr, `unknown model for ${this.engine}`);
    return found;
  }

  checkEffort(c: Checker, model: ModelInfo | undefined, effort: string, ptr: string): void {
    if (this.open || !model) return;
    if (!model.efforts.length) c.fail(ptr, `${model.id} does not accept an effort`);
    else if (!model.efforts.includes(effort)) c.fail(ptr, `must be one of ${model.efforts.join(", ")} for ${model.id}`);
  }
}

function resolveOutput(c: Checker, raw: unknown): { schema: Record<string, unknown>; validate: ValidateFunction } | undefined {
  const out = c.object(raw, "/output", ["schema"]);
  if (!out) return undefined;
  const s = out.schema as Obj | undefined;
  if (typeof s !== "object" || s === null || Array.isArray(s) || s.type !== "object") return c.fail("/output/schema", "must be a JSON Schema object with type \"object\"");
  if (Buffer.byteLength(JSON.stringify(s)) > MAX_SCHEMA_BYTES) return c.fail("/output/schema", "must serialize to at most 65536 bytes");
  if (s.$schema !== undefined && !DRAFT_07.has(String(s.$schema))) return c.fail("/output/schema/$schema", "only JSON Schema draft-07 is supported");
  if (hasRemoteRef(s)) return c.fail("/output/schema", "remote references are not supported");
  try {
    const validate = ajv.compile(s);
    return { schema: s, validate };
  } catch (err) {
    return c.fail("/output/schema", err instanceof Error ? err.message : "is not a valid JSON Schema");
  } finally {
    ajv.removeSchema(s);
  }
}

/** `POST /v1/runs/{id}/messages` body. */
export async function parseMessage(raw: unknown): Promise<{ content: Part[] } | { problem: Problem }> {
  const c = new Checker();
  const o = c.object(raw, "", ["content"]);
  const content = o ? await c.parts(o.content, "/content") : undefined;
  if (c.errors.length || !content) return { problem: problem("invalid_request", "the message is invalid", c.errors) };
  return { content };
}

/** `POST /v1/runs/{id}/items/{item}/response` body (also the A2A data-part answer). */
export function parseResponse(raw: unknown): { response: Response } | { problem: Problem } {
  const c = new Checker();
  const o = c.object(raw, "", ["decision", "answers"]);
  if (o && ("decision" in o) === ("answers" in o)) c.fail("", "must have exactly one of decision or answers");
  else if (o?.decision !== undefined) {
    const decision = c.oneOf(o.decision, "/decision", ["allow", "allow_for_run", "deny"] as const);
    if (decision) return { response: { decision } };
  } else if (o) {
    const answers = c.stringLists(o.answers, "/answers");
    if (answers) return { response: { answers } };
  }
  return { problem: problem("invalid_request", "the response is invalid", c.errors) };
}

function hasRemoteRef(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasRemoteRef);
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value as Obj)) {
    if ((key === "$ref" || key === "$id") && typeof child === "string" && !child.startsWith("#")) return true;
    if (hasRemoteRef(child)) return true;
  }
  return false;
}

async function resolveSkills(c: Checker, raw: unknown): Promise<ResolvedSpec["skills"]> {
  const list = c.array(raw, "/skills", 0, 32) ?? [];
  const out: ResolvedSpec["skills"] = [];
  const seen = new Set<string>();
  for (const [i, entry] of list.entries()) {
    const ptr = `/skills/${i}`;
    const dir = await c.directory(entry, ptr);
    if (dir === undefined) continue;
    const name = path.basename(dir);
    if (!SLUG.test(name)) { c.fail(ptr, `directory name must match ${SLUG.source}`); continue; }
    if (seen.has(name)) { c.fail(ptr, `duplicate skill name ${name}`); continue; }
    try {
      if (!(await stat(path.join(dir, "SKILL.md"))).isFile()) throw new Error();
    } catch {
      c.fail(ptr, "must contain SKILL.md");
      continue;
    }
    seen.add(name);
    out.push({ name, path: dir });
  }
  return out;
}

function resolveMcp(c: Checker, raw: unknown): Record<string, McpServer> {
  const rec = c.record(raw, "/mcp", 64, MCP_NAME);
  const out: Record<string, McpServer> = {};
  for (const [name, value] of Object.entries(rec ?? {})) {
    const ptr = `/mcp/${escape(name)}`;
    const isStdio = typeof value === "object" && value !== null && "command" in value;
    const o = c.object(value, ptr, isStdio ? ["command", "args", "env", "tools"] : ["url", "headers", "tools"]);
    if (!o) continue;
    const tools = o.tools === undefined ? undefined : c.strings(o.tools, `${ptr}/tools`);
    if (isStdio) {
      const command = c.text(o.command, `${ptr}/command`);
      const args = o.args === undefined ? undefined : c.strings(o.args, `${ptr}/args`);
      const env = o.env === undefined ? undefined : c.stringMap(o.env, `${ptr}/env`);
      if (command !== undefined) out[name] = strip({ command, args, env, tools });
    } else {
      const url = c.text(o.url, `${ptr}/url`);
      const headers = o.headers === undefined ? undefined : c.stringMap(o.headers, `${ptr}/headers`);
      if (url === undefined) continue;
      if (!URL.canParse(url)) { c.fail(`${ptr}/url`, "must be a valid URL"); continue; }
      out[name] = strip({ url, headers, tools });
    }
  }
  return out;
}

function resolveSubagents(c: Checker, raw: unknown): Record<string, Subagent> {
  const rec = c.record(raw, "/subagents", 16, SLUG);
  const out: Record<string, Subagent> = {};
  for (const [name, value] of Object.entries(rec ?? {})) {
    const ptr = `/subagents/${escape(name)}`;
    const o = c.object(value, ptr, ["description", "instructions", "model", "effort"]);
    if (!o) continue;
    const description = c.text(o.description, `${ptr}/description`);
    const instructions = c.text(o.instructions, `${ptr}/instructions`);
    const model = o.model === undefined ? undefined : c.text(o.model, `${ptr}/model`);
    const effort = o.effort === undefined ? undefined : c.text(o.effort, `${ptr}/effort`);
    if (description !== undefined && instructions !== undefined) out[name] = strip({ description, instructions, model, effort });
  }
  return out;
}

function resolveEnv(c: Checker, raw: unknown): Record<string, string> {
  const rec = c.record(raw, "/env", 64, ENV_NAME);
  if (!rec) return {};
  for (const name of Object.keys(rec)) if (name.startsWith("BO_")) c.fail(`/env/${escape(name)}`, "BO_* names are reserved");
  return c.stringMap(rec, "/env") ?? {};
}

function resolveLimits(c: Checker, raw: unknown): ResolvedSpec["limits"] {
  const o = c.object(raw, "/limits", ["max_turns", "max_tokens"]);
  if (!o) return {};
  return strip({
    maxTurns: o.max_turns === undefined ? undefined : c.int(o.max_turns, "/limits/max_turns", 1, 10_000),
    maxTokens: o.max_tokens === undefined ? undefined : c.int(o.max_tokens, "/limits/max_tokens", 1, 1_000_000_000),
  });
}

/** The workspace root's instruction files that exist, in `PROJECT_DOCS` order; a file linked twice is read once. */
async function readProjectDocs(c: Checker, root: string): Promise<string[]> {
  const seen = new Set<string>();
  const docs: string[] = [];
  for (const name of PROJECT_DOCS) {
    const real = await realpath(path.join(root, name)).catch(() => undefined);
    if (!real || seen.has(real)) continue;
    seen.add(real);
    const s = await stat(real);
    if (!s.isFile()) continue;
    if (s.size > MAX_PROJECT_DOC_BYTES) { c.fail("/project_instructions", `${name} must be at most 32 KiB`); continue; }
    const text = (await readFile(real, "utf8")).trim();
    if (text) docs.push(text);
  }
  return docs;
}

function invalid(c: Checker): { problem: Problem } {
  return { problem: problem("invalid_spec", "the run spec is invalid", c.errors) };
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel);
}

/** RFC 6901 token escaping. */
function escape(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Drop undefined-valued keys so shapes stay canonical on the wire and in deep-equality tests. */
export function strip<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
