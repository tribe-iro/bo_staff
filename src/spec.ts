// Turning request bodies into what the core runs. Two phases: (1) shape, against the contract schemas
// (`contract/validate.ts`, every error at once); (2) resolution against the world — files and directories, engines,
// models and efforts, sessions, output schemas — which only runs on a well-shaped body.

import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ValidateFunction } from "ajv/dist/ajv.js";
import { ajv, escapePointer, shapeErrors } from "./contract/validate.ts";
import { MAX_IMAGE_BYTES } from "./contract/schema.ts";
import { decodeSession, mint } from "./ids.ts";
import { isMissingFile } from "./fs.ts";
import type {
  Access, Decision, EngineId, EngineInfo, McpServer, ModelInfo, Part, Response, RunSpec, Subagent, Usage,
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
  /** `totals`: the engine's running totals for the session before this run (the baseline for per-run usage). */
  session?: { native: string; fork: boolean; totals?: Usage };
  /** The key a new session is started under (`session.key` named no existing session). */
  sessionKey?: string;
  timeoutMs: number;
}

/** What spec resolution needs to know about engines. */
export interface EngineCatalog {
  info(id: EngineId): Promise<EngineInfo | undefined>;
  defaultEngine(): Promise<EngineId | undefined>;
}

const MAX_DATA_CHARS = 262_144;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_PROJECT_DOC_BYTES = 32 * 1024;
/** Workspace instruction files, in the order they are included. */
const PROJECT_DOCS = ["AGENTS.md", "CLAUDE.md"];
const SKILL_NAME = /^[a-z0-9-]{1,64}$/;
const DRAFT_07 = new Set(["http://json-schema.org/draft-07/schema#", "https://json-schema.org/draft-07/schema#"]);

/** Phase-2 errors: each check records a JSON-Pointer error and returns undefined on failure. */
class Resolution {
  readonly errors: FieldError[] = [];

  fail(pointer: string, detail: string): undefined {
    this.errors.push({ pointer, detail });
    return undefined;
  }

  async directory(p: string, ptr: string): Promise<string | undefined> {
    try {
      const real = await realpath(p);
      if (!(await stat(real)).isDirectory()) return this.fail(ptr, "must be a directory");
      return real;
    } catch {
      return this.fail(ptr, "must exist");
    }
  }

  /** Image files exist and fit; data parts fit. */
  async parts(parts: readonly Part[], ptr: string): Promise<void> {
    for (const [i, part] of parts.entries()) {
      if (part.kind === "image") {
        try {
          const s = await stat(part.path);
          if (!s.isFile()) this.fail(`${ptr}/${i}/path`, "must be a file");
          else if (s.size > MAX_IMAGE_BYTES) this.fail(`${ptr}/${i}/path`, "must be at most 5 MiB");
        } catch {
          this.fail(`${ptr}/${i}/path`, "must exist");
        }
      } else if (part.kind === "data" && (JSON.stringify(part.data) ?? "").length > MAX_DATA_CHARS) {
        this.fail(`${ptr}/${i}/data`, "must serialize to at most 262144 characters");
      }
    }
  }
}

/** `sessions` answers `session.latest` and usage baselines; without it, no earlier session exists. */
export async function resolveSpec(
  body: unknown, engines: EngineCatalog, sessions?: SessionLookup,
): Promise<{ spec: ResolvedSpec } | { problem: Problem }> {
  const shape = shapeErrors("RunSpec", body);
  if (shape.length) return invalid(shape);
  const spec = body as RunSpec;
  const r = new Resolution();

  await r.parts(spec.input, "/input");
  const root = await r.directory(spec.workspace.root, "/workspace/root");
  const extraRoots: string[] = [];
  for (const [i, raw] of (spec.workspace.extra_roots ?? []).entries()) {
    const ptr = `/workspace/extra_roots/${i}`;
    const dir = await r.directory(raw, ptr);
    if (dir === undefined || root === undefined) continue;
    if (dir === root || isInside(root, dir)) r.fail(ptr, "must not be the workspace root or inside it");
    else extraRoots.push(dir);
  }

  const projectDocs = spec.project_instructions !== false && root ? await readProjectDocs(r, root) : [];
  const instructions = [...projectDocs, ...(spec.instructions === undefined ? [] : [spec.instructions])].join("\n\n") || undefined;
  const skills = await resolveSkills(r, spec.skills ?? []);
  for (const name of Object.keys(spec.env ?? {})) if (name.startsWith("BO_")) r.fail(`/env/${escapePointer(name)}`, "BO_* names are reserved");

  const access = spec.permissions?.access ?? "write";
  if (spec.permissions?.internet === false && access === "full") r.fail("/permissions/internet", "cannot be false with access full");
  const internet = spec.permissions?.internet ?? access === "full";
  const output = spec.output ? resolveOutput(r, spec.output.schema) : undefined;

  let session: ResolvedSpec["session"];
  let sessionKey: string | undefined;
  let sessionEngine: EngineId | undefined;
  if (spec.session) {
    const { id: given, latest, key, fork = false } = spec.session;
    if ([given, latest, key].filter((v) => v !== undefined).length !== 1) r.fail("/session", "must have exactly one of id, latest or key");
    else {
      const id = !root ? undefined
        : latest ? sessions?.latest({ workspace: root, engine: spec.engine })?.id
          : key !== undefined ? sessions?.latest({ workspace: root, key })?.id
            : given;
      if (latest && root && id === undefined) {
        r.fail("/session/latest", `no earlier session in ${root}${spec.engine ? ` for ${spec.engine}` : ""}`);
      }
      // A key that names no session yet starts one under it (a fork of nothing is refused).
      if (key !== undefined && root && id === undefined) {
        if (fork) r.fail("/session/fork", `no session with key ${key} in ${root} to fork`);
        else sessionKey = key;
      }
      // A session is one workspace's conversation (the engines keep it per directory, too).
      const owner = given !== undefined && root ? sessions?.get(given)?.workspace : undefined;
      if (owner !== undefined && owner !== root) r.fail("/session/id", `belongs to ${owner}; continue it there`);
      const decoded = id === undefined ? null : decodeSession(id);
      if (decoded && id) {
        // A fork continues its parent's totals too.
        session = strip({ native: decoded.native, fork, totals: sessions?.totals(id) });
        sessionEngine = decoded.engine;
      } else if (given !== undefined) r.fail("/session/id", "must be a session id issued by bo");
    }
  }
  if (sessionEngine && spec.engine && sessionEngine !== spec.engine) r.fail("/engine", `conflicts with the session's engine ${sessionEngine}`);
  const engine = sessionEngine ?? spec.engine ?? await engines.defaultEngine();
  if (!engine) r.fail("/engine", "no engine available");

  if (r.errors.length || !root || !engine) return invalid(r.errors);

  const info = await engines.info(engine);
  if (!info?.available) {
    return { problem: problem("engine_unavailable", `${engine} is unavailable${info?.reason ? `: ${info.reason}` : ""}`) };
  }

  const models = new ModelResolver(info, r);
  const selected = spec.model === undefined ? undefined : models.resolve(spec.model, "/model");
  const runModel = selected ?? models.fallback;
  if (spec.effort !== undefined) models.checkEffort(runModel, spec.effort, "/effort");
  const subagents: Record<string, Subagent> = {};
  for (const [name, agent] of Object.entries(spec.subagents ?? {})) {
    const ptr = `/subagents/${escapePointer(name)}`;
    const agentModel = agent.model === undefined ? runModel : models.resolve(agent.model, `${ptr}/model`);
    if (agent.effort !== undefined) models.checkEffort(agentModel, agent.effort, `${ptr}/effort`);
    subagents[name] = strip({ ...agent, model: agent.model === undefined ? undefined : agentModel?.id ?? agent.model });
  }
  if (r.errors.length) return invalid(r.errors);
  if (runModel?.images === false && spec.input.some((p) => p.kind === "image")) {
    return { problem: problem("unsupported_feature", `${runModel.id} does not accept images`) };
  }

  return {
    spec: {
      runId: mint("run"), engine, input: spec.input, root, extraRoots,
      model: selected?.id, effort: spec.effort, instructions, skills, mcp: spec.mcp ?? {}, subagents,
      access, internet, interactive: spec.interactive ?? false, images: runModel?.images ?? true, env: spec.env ?? {},
      limits: strip({ maxTurns: spec.limits?.max_turns, maxTokens: spec.limits?.max_tokens }),
      schema: output?.schema, validateOutput: output?.validate, session, ...(sessionKey ? { sessionKey } : {}),
      timeoutMs: (spec.timeout_s ?? 1800) * 1000,
    },
  };
}

/** Resolves model ids and aliases against a probed engine; an engine that lists no models accepts any. */
class ModelResolver {
  private readonly byName = new Map<string, ModelInfo>();
  private readonly engine: EngineId;
  private readonly open: boolean;
  private readonly r: Resolution;
  /** The model a run gets when `model` is omitted. */
  readonly fallback: ModelInfo | undefined;

  constructor(info: EngineInfo, r: Resolution) {
    for (const m of info.models) for (const name of [m.id, ...m.aliases]) this.byName.set(name, m);
    this.engine = info.id;
    this.open = info.models.length === 0;
    this.fallback = info.models.find((m) => m.default);
    this.r = r;
  }

  resolve(name: string, ptr: string): ModelInfo | undefined {
    if (this.open) return { id: name, aliases: [], default: false, efforts: [], images: true };
    const found = this.byName.get(name);
    if (!found) this.r.fail(ptr, `unknown model for ${this.engine}`);
    return found;
  }

  checkEffort(model: ModelInfo | undefined, effort: string, ptr: string): void {
    if (this.open || !model) return;
    if (!model.efforts.length) this.r.fail(ptr, `${model.id} does not accept an effort`);
    else if (!model.efforts.includes(effort)) this.r.fail(ptr, `must be one of ${model.efforts.join(", ")} for ${model.id}`);
  }
}

function resolveOutput(r: Resolution, s: Record<string, unknown>): { schema: Record<string, unknown>; validate: ValidateFunction } | undefined {
  if (s.type !== "object") return r.fail("/output/schema", "must be a JSON Schema object with type \"object\"");
  if (Buffer.byteLength(JSON.stringify(s)) > MAX_SCHEMA_BYTES) return r.fail("/output/schema", "must serialize to at most 65536 bytes");
  if (s.$schema !== undefined && !DRAFT_07.has(String(s.$schema))) return r.fail("/output/schema/$schema", "only JSON Schema draft-07 is supported");
  if (hasRemoteRef(s)) return r.fail("/output/schema", "remote references are not supported");
  try {
    return { schema: s, validate: ajv.compile(s) };
  } catch (err) {
    return r.fail("/output/schema", err instanceof Error ? err.message : "is not a valid JSON Schema");
  } finally {
    ajv.removeSchema(s);
  }
}

/** `POST /v1/runs/{id}/messages` body. */
export async function parseMessage(raw: unknown): Promise<{ content: Part[] } | { problem: Problem }> {
  const shape = shapeErrors("MessageBody", raw);
  if (shape.length) return { problem: problem("invalid_request", "the message is invalid", shape) };
  const { content } = raw as { content: Part[] };
  const r = new Resolution();
  await r.parts(content, "/content");
  return r.errors.length ? { problem: problem("invalid_request", "the message is invalid", r.errors) } : { content };
}

/** `POST /v1/runs/{id}/items/{item}/response` body (also the A2A data-part answer). */
export function parseResponse(raw: unknown): { response: Response } | { problem: Problem } {
  const errors = shapeErrors("ResponseBody", raw);
  const body = raw as { decision?: Decision; answers?: Record<string, string[]> };
  if (!errors.length && (body.decision === undefined) === (body.answers === undefined)) {
    errors.push({ pointer: "", detail: "must have exactly one of decision or answers" });
  }
  if (errors.length) return { problem: problem("invalid_request", "the response is invalid", errors) };
  return { response: body.decision !== undefined ? { decision: body.decision } : { answers: body.answers! } };
}

function hasRemoteRef(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasRemoteRef);
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "$ref" || key === "$id") && typeof child === "string" && !child.startsWith("#")) return true;
    if (hasRemoteRef(child)) return true;
  }
  return false;
}

async function resolveSkills(r: Resolution, dirs: readonly string[]): Promise<ResolvedSpec["skills"]> {
  const out: ResolvedSpec["skills"] = [];
  const seen = new Set<string>();
  for (const [i, entry] of dirs.entries()) {
    const ptr = `/skills/${i}`;
    const dir = await r.directory(entry, ptr);
    if (dir === undefined) continue;
    const name = path.basename(dir);
    if (!SKILL_NAME.test(name)) { r.fail(ptr, `directory name must match ${SKILL_NAME.source}`); continue; }
    if (seen.has(name)) { r.fail(ptr, `duplicate skill name ${name}`); continue; }
    try {
      if (!(await stat(path.join(dir, "SKILL.md"))).isFile()) throw new Error();
    } catch {
      r.fail(ptr, "must contain SKILL.md");
      continue;
    }
    seen.add(name);
    out.push({ name, path: dir });
  }
  return out;
}

/** The workspace root's instruction files that exist, in `PROJECT_DOCS` order; a file linked twice is read once. */
async function readProjectDocs(r: Resolution, root: string): Promise<string[]> {
  const seen = new Set<string>();
  const docs: string[] = [];
  for (const name of PROJECT_DOCS) {
    try {
      const real = await realpath(path.join(root, name));
      if (seen.has(real)) continue;
      seen.add(real);
      const s = await stat(real);
      if (!s.isFile()) continue;
      if (s.size > MAX_PROJECT_DOC_BYTES) { r.fail("/project_instructions", `${name} must be at most 32 KiB`); continue; }
      const text = (await readFile(real, "utf8")).trim();
      if (text) docs.push(text);
    } catch (err) {
      if (!isMissingFile(err)) r.fail("/project_instructions", `${name} could not be read`);
    }
  }
  return docs;
}

function invalid(errors: FieldError[]): { problem: Problem } {
  return { problem: problem("invalid_spec", "the run spec is invalid", errors) };
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel);
}

/** Drop undefined-valued keys so shapes stay canonical on the wire and in deep-equality tests. */
export function strip<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
