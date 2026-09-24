import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Created } from "../core/runs.ts";
import { sessionNotFound } from "../core/sessions.ts";
import { isProblem, problem, writeProblem, type Problem } from "../problems.ts";
import { parseMessage, parseResponse, resolveSpec } from "../spec.ts";
import type { Body, Context } from "./context.ts";
import { pipeSse } from "./sse.ts";

type Handler = (ctx: Context, req: IncomingMessage, res: ServerResponse, params: string[], body: () => Promise<Body>) => Promise<void>;

const ROUTES: readonly { method: string; pattern: RegExp; handler: Handler }[] = [
  { method: "GET", pattern: /^\/v1\/engines$/, handler: async (ctx, _req, res) => json(res, 200, await ctx.engines.list()) },
  { method: "POST", pattern: /^\/v1\/runs$/, handler: createRun },
  { method: "GET", pattern: /^\/v1\/runs$/, handler: async (ctx, _req, res) => json(res, 200, ctx.runs.list()) },
  { method: "GET", pattern: /^\/v1\/sessions$/, handler: listSessions },
  { method: "GET", pattern: /^\/v1\/sessions\/([^/]+)$/, handler: async (ctx, _req, res, [id]) => {
    const session = ctx.sessions.get(id!);
    return session ? json(res, 200, session) : writeProblem(res, sessionNotFound(id!));
  } },
  { method: "GET", pattern: /^\/v1\/sessions\/([^/]+)\/runs$/, handler: async (ctx, _req, res, [id]) => {
    if (!ctx.sessions.get(id!)) return writeProblem(res, sessionNotFound(id!));
    json(res, 200, await ctx.sessions.runs(id!));
  } },
  { method: "DELETE", pattern: /^\/v1\/sessions\/([^/]+)$/, handler: async (ctx, _req, res, [id]) => {
    const refused = ctx.runs.deleteSession(id!);
    if (refused) return writeProblem(res, refused);
    res.writeHead(204).end();
  } },
  { method: "GET", pattern: /^\/v1\/runs\/([^/]+)$/, handler: async (ctx, _req, res, [id]) => {
    const run = ctx.runs.get(id!);
    return run ? json(res, 200, run) : writeProblem(res, problem("run_not_found", `no run ${id}`));
  } },
  { method: "GET", pattern: /^\/v1\/runs\/([^/]+)\/events$/, handler: async (ctx, req, res, [id]) => {
    const after = Number(req.headers["last-event-id"] ?? 0);
    const observed = ctx.runs.observe(id!, Number.isFinite(after) ? after : 0);
    if (isProblem(observed)) return writeProblem(res, observed);
    const piped = pipeSse(res, observed);
    ctx.streams.add(piped);
    try { await piped; } finally { ctx.streams.delete(piped); }
  } },
  { method: "POST", pattern: /^\/v1\/runs\/([^/]+)\/messages$/, handler: async (ctx, _req, res, [id], body) => {
    const b = await body();
    if ("problem" in b) return writeProblem(res, b.problem);
    const parsed = await parseMessage(b.raw);
    if ("problem" in parsed) return writeProblem(res, parsed.problem);
    return accepted(res, ctx.runs.message(id!, parsed.content), 202);
  } },
  { method: "POST", pattern: /^\/v1\/runs\/([^/]+)\/items\/([^/]+)\/response$/, handler: async (ctx, _req, res, [id, itemId], body) => {
    const b = await body();
    if ("problem" in b) return writeProblem(res, b.problem);
    const parsed = parseResponse(b.raw);
    if ("problem" in parsed) return writeProblem(res, parsed.problem);
    return accepted(res, ctx.runs.respond(id!, itemId!, parsed.response), 204);
  } },
  { method: "POST", pattern: /^\/v1\/runs\/([^/]+)\/cancel$/, handler: async (ctx, _req, res, [id]) => accepted(res, ctx.runs.cancel(id!), 202) },
];

/** Dispatches a /v1 request; `false` when no route's path matches. */
export async function routeV1(ctx: Context, req: IncomingMessage, res: ServerResponse, pathname: string, body: () => Promise<Body>): Promise<boolean> {
  const allowed: string[] = [];
  for (const { method, pattern, handler } of ROUTES) {
    const m = pattern.exec(pathname);
    if (!m) continue;
    if (req.method !== method) { allowed.push(method); continue; }
    const params = decodeParams(m.slice(1));
    if (!params) writeProblem(res, problem("not_found", `no route ${req.method} ${pathname}`));
    else await handler(ctx, req, res, params, body);
    return true;
  }
  if (!allowed.length) return false;
  writeProblem(res, problem("method_not_allowed", `${req.method} is not allowed on ${pathname}`), { allow: allowed.join(", ") });
  return true;
}

async function createRun(ctx: Context, req: IncomingMessage, res: ServerResponse, _p: string[], body: () => Promise<Body>): Promise<void> {
  const b = await body();
  if ("problem" in b) return writeProblem(res, b.problem);
  const key = req.headers["idempotency-key"];
  const idem = typeof key === "string" && key ? { key, hash: specHash(b.raw) } : undefined;
  // A replay answers before validation: it must not touch the filesystem or mint a run id.
  const replayed = idem && ctx.runs.replay(idem.key, idem.hash);
  if (replayed) return created(res, replayed);
  const resolved = await resolveSpec(b.raw, ctx.engines, ctx.sessions);
  if ("problem" in resolved) return writeProblem(res, resolved.problem);
  return created(res, await ctx.runs.create(resolved.spec, { idempotency: idem }));
}


/** `GET /v1/sessions[?workspace=<absolute path>]`: newest first. */
async function listSessions(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const workspace = new URL(req.url ?? "/", "http://bo").searchParams.get("workspace");
  if (workspace === null) return json(res, 200, ctx.sessions.list());
  if (!path.isAbsolute(workspace)) {
    return writeProblem(res, problem("invalid_request", "the query is invalid", [{ pointer: "/workspace", detail: "must be an absolute path" }]));
  }
  // Sessions are keyed by the resolved workspace root, as runs resolve it.
  json(res, 200, ctx.sessions.list(await realpath(workspace).catch(() => workspace)));
}

function created(res: ServerResponse, result: Created): void {
  if ("problem" in result) return writeProblem(res, result.problem);
  res.setHeader("location", `/v1/runs/${result.run.id}`);
  json(res, result.replayed ? 200 : 201, result.run);
}

function accepted(res: ServerResponse, p: Problem | undefined, status: 202 | 204): void {
  if (p) return writeProblem(res, p);
  if (status === 204) res.writeHead(204).end();
  else json(res, 202, {});
}

function decodeParams(raw: string[]): string[] | undefined {
  try {
    return raw.map(decodeURIComponent);
  } catch {
    return undefined;
  }
}

/** Canonical JSON (sorted keys) so equivalent bodies share an idempotency hash. */
export function specHash(raw: unknown): string {
  const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
  return createHash("sha256").update(JSON.stringify(canon(raw))).digest("hex");
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
