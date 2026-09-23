// bo CLI. Sugar lives here; everything it sends is the canonical RunSpec.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { Bo, BoProblem, RunHandle } from "./client.ts";
import { Config, ConfigError } from "./config.ts";
import { startServer } from "./http/server.ts";
import { streamLogger } from "./log.ts";
import { EXPECTED_WARNINGS } from "./harness/claude-code/index.ts";
import { ACCESS_LEVELS, ENGINE_IDS, type Item, type ImageMediaType, type Part, type RunSpec } from "./model.ts";
import {
  approvalPrompt, configTable, enginesTable, errorText, problemText, questionPrompt, RunView, runsTable, sessionsTable,
  styleFor, type Style, type Verbosity,
} from "./render.ts";
import { VERSION } from "./version.ts";

const EXT_MEDIA: Record<string, ImageMediaType> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

class UsageError extends Error {}

interface Io {
  out: NodeJS.WritableStream & { isTTY?: boolean };
  err: NodeJS.WritableStream & { isTTY?: boolean };
  in: NodeJS.ReadableStream & { isTTY?: boolean };
}

const USAGE = `bo ${VERSION}: Claude Code and Codex behind one service

usage:
  bo run [flags] <prompt…>       run and print the answer ("-" or no words reads stdin)
  bo run -c <prompt…>            continue this directory's latest session
  bo sessions [--all]            this directory's sessions (--all: every directory)
  bo runs                        runs of the last 10 minutes
  bo follow <run_id>             follow a run
  bo cancel <run_id>             cancel a run
  bo engines                     engines, models, efforts
  bo config                      every setting, its value, and where it comes from
  bo serve [--host HOST] [--port PORT] [--token TOKEN] [--max-runs N] [--default-engine ENGINE]
           [--allow-subscription-auth] [-v]

run flags:
  --engine <engine>   --model <model>   --effort <effort>   --instructions <text>
  --skill <dir>…   --mcp <file.json>   --subagents <file.json>
  --workspace <dir>   --extra-root <dir>…   --access <read|write|full>
  --internet | --no-internet   --interactive | --no-interactive
  --schema <file.json>   -c | --continue   --session <ses_…>   --fork   --image <file>…   --timeout <seconds>
  --env <NAME=value>…   --max-turns <n>   --max-tokens <n>   --no-project-instructions
output: -v (steps, summary)   -vv (reasoning, tool output, ids)   --json (event stream)
shared: --url <url>   --token <token> (default $BO_TOKEN)
settings: ~/.config/bo/config.toml ([run], [serve], url); \`bo config\` shows them
`;

export async function main(
  argv: string[], io: Io = { out: process.stdout, err: process.stderr, in: process.stdin }, env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    return await dispatch(argv, io, env);
  } catch (err) {
    const style = styleFor(io.err);
    if (err instanceof UsageError) io.err.write(errorText(err.message, "`bo --help` lists every command and flag", style));
    else if (err instanceof ConfigError) io.err.write(errorText(err.message, "`bo config` shows every setting and its source", style));
    else if (err instanceof BoProblem) io.err.write(problemText(err.problem, style));
    else io.err.write(errorText(err instanceof Error ? err.message : String(err), undefined, style));
    return err instanceof UsageError || err instanceof BoProblem || err instanceof ConfigError ? 2 : 1;
  }
}

const COMMANDS = new Set(["serve", "run", "runs", "sessions", "follow", "cancel", "engines", "config"]);
const HELP = new Set(["--help", "-h", "help"]);

async function dispatch(argv: string[], io: Io, env: NodeJS.ProcessEnv): Promise<number> {
  // Help is a command position, never a prompt word: `bo run explain --help` runs.
  if (HELP.has(argv[0] ?? "") || argv[1] === "--help") { io.out.write(USAGE); return 0; }
  const head = argv[0];
  if (!head) { io.err.write(USAGE); return 2; }
  if (!COMMANDS.has(head)) throw new UsageError(`unknown command "${head}"`);
  const config = await Config.load(env);
  if (head === "serve") return serve(argv.slice(1), io, config, env);
  const shared = takeShared(argv.slice(1));
  if (head === "config") {
    noArgs(shared.args, "config");
    const rows = config.explain({ url: shared.url });
    io.out.write(shared.json ? `${JSON.stringify(rows)}\n` : configTable(rows, config.exists ? config.file : `${config.file} (not found)`, env.BO_TOKEN ? "env BO_TOKEN" : undefined, styleFor(io.out)));
    return 0;
  }
  const bo = new Bo({ url: config.get("url", shared.url).value!, token: shared.token ?? env.BO_TOKEN });
  const output = { json: shared.json, verbosity: shared.verbosity ?? config.get("run.verbose").value as Verbosity };
  switch (head) {
    case "follow": return follow(await bo.runs.get(onlyArg(shared.args, "run id")), output, io, false);
    case "cancel": await (await bo.runs.get(onlyArg(shared.args, "run id"))).cancel(); return 0;
    case "runs": {
      noArgs(shared.args, "runs");
      const runs = await bo.runs.list();
      io.out.write(shared.json ? `${JSON.stringify(runs)}\n` : runsTable(runs, styleFor(io.out)));
      return 0;
    }
    case "sessions": {
      const all = shared.args.includes("--all");
      const rest = shared.args.filter((a) => a !== "--all");
      const workspace = all ? undefined : path.resolve(rest[0] === "--workspace" ? need(rest[1], "--workspace") : ".");
      if (rest.length && rest[0] !== "--workspace" || rest.length > 2) throw new UsageError("sessions takes --all or --workspace <dir>");
      const sessions = await bo.sessions.list(workspace);
      io.out.write(shared.json ? `${JSON.stringify(sessions)}\n` : sessionsTable(sessions, styleFor(io.out), { workspace }));
      return 0;
    }
    case "engines": {
      noArgs(shared.args, "engines");
      const engines = await bo.engines();
      io.out.write(shared.json ? `${JSON.stringify(engines)}\n` : enginesTable(engines, styleFor(io.out)));
      return 0;
    }
  }
  const spec = await parseRun(shared.args, io, config);
  const handle = await bo.run(spec.spec);
  return follow(handle, output, io, spec.interactive);
}

async function serve(argv: string[], io: Io, config: Config, processEnv: NodeJS.ProcessEnv): Promise<number> {
  let host: string | undefined;
  let port: number | undefined;
  let token: string | undefined;
  let maxRuns: number | undefined;
  let defaultEngine: RunSpec["engine"];
  let allowSubscriptionAuth: true | undefined;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = () => need(argv[++i], flag);
    if (flag === "--host") host = value();
    else if (flag === "--port") port = positiveInt(value(), flag, true);
    else if (flag === "--token") token = value();
    else if (flag === "--max-runs") maxRuns = positiveInt(value(), flag);
    else if (flag === "--default-engine") defaultEngine = oneOf(value(), ENGINE_IDS, flag);
    else if (flag === "--allow-subscription-auth") allowSubscriptionAuth = true;
    else if (flag === "-v") verbose = true;
    else throw new UsageError(`unknown serve flag ${flag}`);
  }
  // The harnesses read the subscription opt-in from their environment; the flag and config.toml set it there.
  const allow = config.get("serve.allow_subscription_auth", allowSubscriptionAuth).value;
  const env = { ...processEnv, BO_ALLOW_SUBSCRIPTION_AUTH: allow ? "1" : "" };
  const log = streamLogger(io.err);
  // Node's own warning printer is replaced by the server log; warnings bo expects by design are dropped.
  process.removeAllListeners("warning");
  process.on("warning", (w: Error & { code?: string }) => { if (!EXPECTED_WARNINGS.has(w.code ?? "")) log(`warning: ${w.message}`); });
  const server = await startServer({
    host: config.get("serve.host", host).value, port: config.get("serve.port", port).value,
    maxRuns: config.get("serve.max_runs", maxRuns).value, defaultEngine: config.get("serve.default_engine", defaultEngine).value,
    token, env, log, verbose,
  });
  io.err.write(banner(server.url, server.authenticated, await server.engines.list(), styleFor(io.err)));
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      void server.close().then(resolve, resolve);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}

function takeShared(argv: string[]): { args: string[]; json: boolean; verbosity?: Verbosity; url?: string; token?: string } {
  const args: string[] = [];
  let json = false;
  let verbosity: Verbosity | undefined;
  let url: string | undefined;
  let token: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") json = true;
    else if (a === "-v" || a === "-vv") verbosity = Math.min(2, (verbosity ?? 0) + a.length - 1) as Verbosity;
    else if (a === "--url") url = need(argv[++i], "--url");
    else if (a === "--token") token = need(argv[++i], "--token");
    else args.push(a);
  }
  return { args, json, verbosity, url, token };
}

async function parseRun(argv: string[], io: Io, config: Config): Promise<{ spec: RunSpec; interactive: boolean }> {
  const inputTokens: (string | Part)[] = [];
  const workspace: RunSpec["workspace"] = { root: process.cwd() };
  const permissions: NonNullable<RunSpec["permissions"]> = {};
  const selected: Partial<Pick<RunSpec, "engine" | "model" | "effort" | "instructions" | "skills" | "mcp" | "subagents">> = {};
  let interactive = Boolean(io.in.isTTY && io.err.isTTY);
  let schema: Record<string, unknown> | undefined;
  let session: RunSpec["session"];
  let fork = false;
  let continued = false;
  let timeout: number | undefined;
  let projectInstructions: boolean | undefined;
  let env: Record<string, string> | undefined;
  const limits: NonNullable<RunSpec["limits"]> = {};
  const abs = (p: string) => path.resolve(p);
  const readJson = async (file: string) => JSON.parse(await readFile(abs(file), "utf8")) as Record<string, unknown>;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const val = () => need(argv[++i], a);
    switch (a) {
      case "--engine": selected.engine = oneOf(val(), ENGINE_IDS, a); break;
      case "--model": selected.model = val(); break;
      case "--effort": selected.effort = val(); break;
      case "--instructions": selected.instructions = val(); break;
      case "--skill": (selected.skills ??= []).push(abs(val())); break;
      case "--mcp": selected.mcp = await readJson(val()) as NonNullable<typeof selected.mcp>; break;
      case "--subagents": selected.subagents = await readJson(val()) as NonNullable<typeof selected.subagents>; break;
      case "--workspace": workspace.root = abs(val()); break;
      case "--extra-root": (workspace.extra_roots ??= []).push(abs(val())); break;
      case "--access": permissions.access = oneOf(val(), ACCESS_LEVELS, a); break;
      case "--internet": permissions.internet = true; break;
      case "--no-internet": permissions.internet = false; break;
      case "--interactive": interactive = true; break;
      case "--no-interactive": interactive = false; break;
      case "--schema": schema = await readJson(val()); break;
      case "--session": session = { id: val() }; break;
      case "-c":
      case "--continue": continued = true; break;
      case "--fork": fork = true; break;
      case "--image": {
        const file = abs(val());
        const media = EXT_MEDIA[path.extname(file).toLowerCase()];
        if (!media) throw new UsageError(`--image: unsupported image type ${path.extname(file)}`);
        inputTokens.push({ kind: "image", path: file, media_type: media });
        break;
      }
      case "--timeout": timeout = positiveInt(val(), a); break;
      case "--no-project-instructions": projectInstructions = false; break;
      case "--env": {
        const pair = val();
        const eq = pair.indexOf("=");
        if (eq < 1) throw new UsageError("--env requires NAME=value");
        (env ??= {})[pair.slice(0, eq)] = pair.slice(eq + 1);
        break;
      }
      case "--max-turns": limits.max_turns = positiveInt(val(), a); break;
      case "--max-tokens": limits.max_tokens = positiveInt(val(), a); break;
      default:
        if (a.startsWith("-") && a !== "-") throw new UsageError(`unknown flag ${a}`);
        inputTokens.push(a);
    }
  }
  if (continued && session) throw new UsageError("use either -c (latest session here) or --session <id>, not both");
  if (continued) session = { latest: true };
  if (fork && !session) throw new UsageError("--fork requires -c or --session <id>");
  // config.toml's run defaults shape new sessions; a continued session keeps its own engine and model.
  if (!session) {
    selected.engine ??= config.get("run.engine").value;
    selected.model ??= config.get("run.model").value;
    selected.effort ??= config.get("run.effort").value;
  }
  permissions.access ??= config.get("run.access").value;
  const placeholders = inputTokens.filter((token) => token === "-").length;
  if (placeholders > 1) throw new UsageError("stdin placeholder '-' may appear only once");
  const hasWords = inputTokens.some((token) => typeof token === "string");
  const consumesStdin = placeholders === 1 || !hasWords;
  const stdin = consumesStdin ? await readStdin(io.in) : undefined;
  if (consumesStdin) interactive = false;
  const expanded = placeholders
    ? inputTokens.map((token) => token === "-" ? stdin! : token)
    : hasWords ? inputTokens : [stdin!, ...inputTokens];
  const input: Part[] = [];
  let words: string[] = [];
  const flushWords = () => {
    if (words.length) input.push({ kind: "text", text: words.join(" ") });
    words = [];
  };
  for (const token of expanded) {
    if (typeof token === "string") words.push(token);
    else { flushWords(); input.push(token); }
  }
  flushWords();
  if (!input.length || input.every((part) => part.kind === "text" && !part.text.trim())) throw new UsageError("empty prompt");

  const spec: RunSpec = {
    input,
    workspace,
    ...selected,
    ...(Object.keys(permissions).length ? { permissions } : {}),
    ...(projectInstructions === false ? { project_instructions: false } : {}),
    interactive,
    ...(env ? { env } : {}),
    ...(Object.keys(limits).length ? { limits } : {}),
    ...(schema ? { output: { schema } } : {}),
    ...(session ? { session: { ...session, ...(fork ? { fork } : {}) } } : {}),
    ...(timeout ? { timeout_s: timeout } : {}),
  };
  return { spec, interactive };
}

async function follow(handle: RunHandle, output: { json: boolean; verbosity: Verbosity }, io: Io, interactive: boolean): Promise<number> {
  const { json } = output;
  const ac = new AbortController();
  let interrupts = 0;
  const onSigint = () => {
    if (++interrupts > 1) process.exit(130);
    void handle.cancel().catch(() => undefined);
    setTimeout(() => ac.abort(), 15_000).unref();
  };
  process.on("SIGINT", onSigint);
  const prompter = interactive ? new Prompter(handle, io) : undefined;
  const view = new RunView(io.out, io.err, { verbosity: output.verbosity });
  try {
    for await (const e of handle.events({ signal: ac.signal })) {
      if (json) io.out.write(`${JSON.stringify(e)}\n`);
      else view.event(e);
      if (e.event === "item" && prompter) prompter.item(e.data);
    }
  } catch (err) {
    if (!ac.signal.aborted) throw err;
  } finally {
    process.off("SIGINT", onSigint);
    prompter?.close();
  }
  const run = handle.run;
  if (!json) view.finish(run);
  return run.status === "completed" ? 0 : run.status === "cancelled" ? 130 : 1;
}

/** Answers awaiting items from the terminal; any other line steers the run. */
class Prompter {
  private readonly rl: Interface;
  private readonly queue: Item[] = [];
  private serial = Promise.resolve();
  private question?: { itemId: string; index: number; answers: Record<string, string[]> };

  private readonly handle: RunHandle;
  private readonly io: Io;
  private readonly style: Style;

  constructor(handle: RunHandle, io: Io) {
    this.handle = handle;
    this.io = io;
    this.style = styleFor(io.err);
    this.rl = createInterface({ input: io.in, terminal: false });
    this.rl.on("line", (line) => { this.serial = this.serial.then(() => this.onLine(line.trim())); });
  }

  item(item: Item): void {
    const awaiting = (item.type === "action" && item.status === "awaiting_approval") || (item.type === "question" && item.status === "awaiting_answer");
    const idx = this.queue.findIndex((q) => q.id === item.id);
    if (awaiting && idx < 0) {
      this.queue.push(item);
      if (this.queue.length === 1) this.ask(item);
    } else if (!awaiting && idx >= 0) {
      this.queue.splice(idx, 1);
      if (idx === 0 && this.queue[0]) this.ask(this.queue[0]);
    }
  }

  close(): void {
    this.rl.close();
  }

  private ask(item: Item): void {
    if (item.type === "action") {
      this.io.err.write(approvalPrompt(item, this.style));
    } else if (item.type === "question") {
      if (!this.question || this.question.itemId !== item.id) this.question = { itemId: item.id, index: 0, answers: {} };
      const q = item.questions[this.question.index];
      if (q) this.io.err.write(questionPrompt(q, this.style));
    }
  }

  private async onLine(line: string): Promise<void> {
    const current = this.queue[0];
    try {
      if (!current) {
        if (line) await this.handle.message(line);
        return;
      }
      if (current.type === "action") {
        const decision = line === "y" ? "allow" : line === "a" ? "allow_for_run" : line === "n" ? "deny" : undefined;
        if (!decision) { this.ask(current); return; }
        await this.handle.respond(current.id, { decision });
        this.advance(current.id);
      } else if (current.type === "question") {
        const state = this.question?.itemId === current.id ? this.question : { itemId: current.id, index: 0, answers: {} as Record<string, string[]> };
        this.question = state;
        const q = current.questions[state.index]!;
        const picks = line.split(",").map((value) => value.trim()).filter(Boolean);
        if (!picks.length) { this.ask(current); return; }
        const indexed = q.options && picks.every((pick) => /^\d+$/.test(pick) && q.options![Number(pick) - 1] !== undefined);
        const values = indexed ? picks.map((pick) => q.options![Number(pick) - 1]!) : picks;
        if (!q.multiple && values.length !== 1) { this.io.err.write(this.style.yellow("  pick exactly one\n")); this.ask(current); return; }
        state.answers[q.id] = q.multiple ? values : values.slice(0, 1);
        state.index++;
        if (state.index < current.questions.length) this.ask(current);
        else {
          await this.handle.respond(current.id, { answers: state.answers });
          this.question = undefined;
          this.advance(current.id);
        }
      }
    } catch (err) {
      this.io.err.write(err instanceof BoProblem ? problemText(err.problem, this.style) : errorText(err instanceof Error ? err.message : String(err), undefined, this.style));
    }
  }

  private advance(itemId: string): void {
    const index = this.queue.findIndex((item) => item.id === itemId);
    if (index >= 0) this.queue.splice(index, 1);
    if (this.queue[0]) this.ask(this.queue[0]);
  }
}

function banner(url: string, authenticated: boolean, engines: readonly import("./model.ts").EngineInfo[], style: Style): string {
  const { bold, dim, green, red } = style;
  const lines = engines.map((e) => e.available
    ? `  ${green("●")} ${e.id} ${dim(`${e.version ?? ""} · ${e.authentication}`)}`
    : `  ${red("○")} ${e.id} ${dim("unavailable:")} ${e.reason ?? ""}`);
  return `${bold(`bo ${VERSION}`)} listening on ${bold(url)} ${dim(authenticated ? "· bearer token required" : "· loopback only")}\n`
    + `${lines.join("\n")}\n${dim("ctrl-c stops the server; running runs are cancelled")}\n`;
}

function need(v: string | undefined, flag: string): string {
  if (v === undefined) throw new UsageError(`${flag} requires a value`);
  return v;
}

function onlyArg(args: string[], name: string): string {
  if (args.length !== 1) throw new UsageError(`${name} required and must be the only argument`);
  return args[0]!;
}

function noArgs(args: string[], command: string): void {
  if (args.length) throw new UsageError(`${command} takes no positional arguments`);
}

function positiveInt(value: string, flag: string, allowZero = false): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) throw new UsageError(`${flag} requires ${allowZero ? "a non-negative" : "a positive"} integer`);
  return parsed;
}

function oneOf<T extends string>(v: string, values: readonly T[], flag: string): T {
  if (!values.includes(v as T)) throw new UsageError(`${flag} must be one of ${values.join(", ")}`);
  return v as T;
}

async function readStdin(input: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of input as AsyncIterable<Buffer | string>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

