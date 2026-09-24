import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { AgentCard as AgentCardCodec } from "@a2a-js/sdk";
import path from "node:path";
import { Config } from "../config.ts";
import { Engines } from "../core/engines.ts";
import { SessionIndex } from "../core/sessions.ts";
import { stateDir } from "../paths.ts";
import { RunManager } from "../core/runs.ts";
import { createClaudeCode } from "../harness/claude-code/index.ts";
import { createCodex } from "../harness/codex/index.ts";
import type { Harness } from "../harness/port.ts";
import type { EngineId } from "../model.ts";
import { problem, writeProblem } from "../problems.ts";
import { A2aService } from "../a2a/binding.ts";
import { describe, silent, type Logger } from "../log.ts";
import type { Body, Context } from "./context.ts";
import { json, routeV1 } from "./v1.ts";

const MAX_BODY = 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
/** Host header names a tokenless (loopback-only) server answers to; anything else is a DNS-rebinding attempt. */
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;
const AGENT_CARD = "/.well-known/agent-card.json";

export interface ServerOptions {
  host?: string;
  port?: number;
  token?: string;
  maxRuns?: number;
  defaultEngine?: EngineId;
  engines?: Harness[];
  env?: NodeJS.ProcessEnv;
  /** Re-probe interval for unavailable engines. */
  reprobeMs?: number;
  /** Server log (run lifecycle, failures); silent by default. */
  log?: Logger;
  /** Also log each run's steps (`bo serve -v`). */
  verbose?: boolean;
  /** Where the session index is kept; default `$XDG_STATE_HOME/bo/sessions.json`, `null` keeps it in memory. */
  sessionsFile?: string | null;
}

export interface BoServer {
  server: Server;
  runs: RunManager;
  engines: Engines;
  /** Whether requests must carry the bearer token. */
  authenticated: boolean;
  url: string;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions = {}): Promise<BoServer> {
  const env = opts.env ?? process.env;
  // Options win; otherwise the environment, through the same key table the CLI and `bo config` use.
  const settings = Config.fromEnv(env);
  const host = settings.get("serve.host", opts.host).value!;
  const port = settings.get("serve.port", opts.port).value!;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("port must be an integer 0–65535");
  const token = (opts.token ?? env.BO_TOKEN) || undefined;
  const maxRuns = settings.get("serve.max_runs", opts.maxRuns).value!;
  if (!Number.isInteger(maxRuns) || maxRuns <= 0) throw new Error("max runs must be a positive integer");
  if (!LOOPBACK.has(host) && !token) throw new Error(`refusing to listen on ${host} without BO_TOKEN`);

  const engines = await Engines.start(opts.engines ?? [createClaudeCode({ env }), createCodex({ env })], {
    defaultEngine: settings.get("serve.default_engine", opts.defaultEngine).value,
    reprobeMs: opts.reprobeMs,
  });
  const log = opts.log ?? silent;
  const sessionsFile = opts.sessionsFile === undefined ? path.join(stateDir(env), "sessions.json") : opts.sessionsFile;
  const sessions = sessionsFile === null ? SessionIndex.memory() : await SessionIndex.open(sessionsFile, log);
  const runs = new RunManager({ engines, maxRuns, sessions, log, logSteps: opts.verbose ?? false });
  const ctx: Context = { runs, engines, sessions, streams: new Set() };
  let url = "";
  const a2a = new A2aService(ctx, env, () => (env.BO_PUBLIC_URL || url).replace(/\/$/, ""), Boolean(token));

  let closing = false;
  const server = createServer((req, res) => {
    if (closing) return writeProblem(res, problem("unavailable", "server is shutting down"));
    handle(ctx, a2a, req, res, token).catch((err: unknown) => {
      const requestId = randomUUID();
      log(`request ${requestId} failed: ${req.method} ${req.url}`, [
        ...describe(err), ...(err instanceof Error && err.stack ? err.stack.split("\n").slice(1, 6).map((l) => l.trim()) : []),
      ]);
      if (!res.headersSent) writeProblem(res, problem("internal", `internal error (${requestId})`));
      else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  url = `http://${host.includes(":") ? `[${host}]` : host}:${typeof address === "object" && address ? address.port : port}`;
  return {
    server, runs, engines, authenticated: Boolean(token), url,
    async close() {
      closing = true;
      await runs.shutdown();
      // Sockets close either way; a session change that could not be written is reported after.
      let unsaved: unknown;
      await sessions.flush().catch((err: unknown) => { unsaved = err; });
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([Promise.allSettled([...ctx.streams]), new Promise((resolve) => { timer = setTimeout(resolve, 3000); })]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      server.closeAllConnections();
      await closed;
      if (unsaved) throw unsaved;
    },
  };
}

async function handle(ctx: Context, a2a: A2aService, req: IncomingMessage, res: ServerResponse, token: string | undefined): Promise<void> {
  if (!token && !LOOPBACK_HOST.test(req.headers.host ?? "")) {
    return writeProblem(res, problem("forbidden_host", "a server without a token only answers to loopback host names"));
  }
  const { pathname } = new URL(req.url ?? "/", "http://bo");
  // The agent card is public discovery: it advertises the bearer scheme the other routes require.
  if (req.method === "GET" && pathname === AGENT_CARD) return json(res, 200, AgentCardCodec.toJSON(a2a.agentCard()));
  if (token && !authorized(req.headers.authorization, token)) return writeProblem(res, problem("unauthorized", "a valid bearer token is required"));
  const body = memo(() => readBody(req, res));

  if (req.method === "POST" && pathname === "/a2a") {
    const routed = a2a.route(req, res, body);
    ctx.streams.add(routed);
    try { return await routed; } finally { ctx.streams.delete(routed); }
  }
  if (await routeV1(ctx, req, res, pathname, body)) return;
  writeProblem(res, problem("not_found", `no route ${req.method} ${pathname}`));
}

function authorized(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function readBody(req: IncomingMessage, res: ServerResponse): Promise<Body> {
  const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json" && !type.endsWith("+json")) {
    req.resume();
    return { problem: problem("unsupported_media_type", "content-type must be application/json") };
  }
  const declared = Number(req.headers["content-length"]);
  const chunks: Buffer[] = [];
  let size = 0;
  if (declared <= MAX_BODY || !Number.isFinite(declared)) {
    for await (const chunk of req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_BODY) break;
      chunks.push(chunk);
    }
  }
  if (declared > MAX_BODY || size > MAX_BODY) {
    // Do not read the rest: answer and drop the connection.
    res.setHeader("connection", "close");
    return { problem: problem("payload_too_large", "request body exceeds 1 MiB") };
  }
  try {
    return { raw: JSON.parse(Buffer.concat(chunks, size).toString("utf8")) };
  } catch {
    return { problem: problem("invalid_json", "request body is not valid JSON") };
  }
}

function memo<T>(f: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => (p ??= f());
}
