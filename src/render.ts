// Terminal presentation for the CLI: one voice for runs, listings, prompts and errors.
// stdout carries only results; everything else goes to stderr. Colour only on a TTY, never with NO_COLOR.

import { count, duration, summary, usd } from "./format.ts";
import type { Action, EngineInfo, ErrorCode, Item, Run, Session, SessionRun, StreamEvent, Usage } from "./model.ts";
import type { Problem } from "./problems.ts";

export interface Stream { write(s: string): unknown; isTTY?: boolean }

export interface Style {
  dim(s: string): string;
  bold(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

const sgr = (on: number, off: number) => (s: string) => `\x1b[${on}m${s}\x1b[${off}m`;
const COLOR: Style = { dim: sgr(2, 22), bold: sgr(1, 22), red: sgr(31, 39), green: sgr(32, 39), yellow: sgr(33, 39), cyan: sgr(36, 39) };
const PLAIN: Style = { dim: (s) => s, bold: (s) => s, red: (s) => s, green: (s) => s, yellow: (s) => s, cyan: (s) => s };

export function styleFor(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): Style {
  return stream.isTTY && !env.NO_COLOR && env.TERM !== "dumb" ? COLOR : PLAIN;
}

/** What to do next, by run error code. */
const ERROR_HINTS: Record<ErrorCode, string> = {
  auth_failed: "check the engine's own login (`claude` → /login, `codex login`)",
  rate_limited: "wait and retry, or try the other engine with --engine",
  context_exceeded: "start a fresh session, or ask for less at once",
  timeout: "raise --timeout (seconds)",
  invalid_output: "the answer did not match --schema; loosen the schema or say more in the prompt",
  limit_exceeded: "raise --max-turns or --max-tokens",
  resource_exhausted: "the run produced more output than bo keeps; split the task",
  engine_unavailable: "`bo engines` shows why",
  engine_error: "the server log has the engine's own error for this run",
};

export type Verbosity = 0 | 1 | 2;

/**
 * One transient line on a terminal (`⠋ $ npm test · 42s`): redrawn in place, erased before anything else is written,
 * never left in the scrollback. Inert off a terminal.
 */
export class StatusLine {
  private static readonly FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private readonly stream: Stream & { columns?: number };
  private readonly style: Style;
  private readonly started = Date.now();
  private text = "working";
  private frame = 0;
  private drawn = false;
  private held = false;
  private timer?: NodeJS.Timeout;

  constructor(stream: Stream & { columns?: number }, style: Style) {
    this.stream = stream;
    this.style = style;
    if (stream.isTTY) this.timer = setInterval(() => { this.frame++; if (this.drawn) this.draw(); }, 100).unref();
  }

  set(text: string): void {
    this.text = text;
    if (this.drawn) this.draw();
  }

  /** Erases the line (call before writing anything); `hold` keeps it away until `release`. */
  erase(hold = false): void {
    if (this.drawn) this.stream.write("\r\x1b[2K");
    this.drawn = false;
    if (hold) this.held = true;
  }

  release(): void {
    this.held = false;
  }

  /** Draws the line; only call when the cursor is at the start of a line. */
  draw(): void {
    if (!this.timer || this.held) return;
    const elapsed = Math.round((Date.now() - this.started) / 1000);
    const width = Math.max(10, (this.stream.columns ?? 80) - 1);
    const line = `${StatusLine.FRAMES[this.frame % StatusLine.FRAMES.length]} ${this.text} · ${elapsed}s`;
    this.stream.write(`\r\x1b[2K${this.style.dim(line.length > width ? `${line.slice(0, width - 1)}…` : line)}`);
    this.drawn = true;
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.erase();
  }
}

/**
 * Renders a followed run at a verbosity:
 * - 0: the agent's words on a terminal (streamed), a transient status line; piped, the answer once. Failures and
 *   denied actions are always reported.
 * - 1: plus one line per step and a summary line (model, time, tokens, cost) with how to continue.
 * - 2: plus reasoning, tool output, subagent messages, and ids.
 * stdout carries only the agent's words; everything else is stderr.
 */
export class RunView {
  private readonly err: Stream;
  private readonly out: Stream;
  private readonly style: Style;
  private readonly verbosity: Verbosity;
  /** Rendering a stored run (`bo show`): no status line, no "continue" hint. */
  private readonly replay: boolean;
  /** Where the agent's top-level words go: the terminal's stdout, else stderr from -v, else nowhere (piped). */
  private readonly words: Stream | undefined;
  private readonly status: StatusLine;
  private readonly atLineStart = new Map<Stream, boolean>();
  private streaming?: string;
  /** stderr has output: the closing lines are set apart by a blank line. */
  private printed = false;
  /** Text of the last completed top-level agent message already shown as words. */
  private shown?: string;
  private readonly seen = new Set<string>();
  private readonly denied = new Set<string>();
  private readonly awaiting = new Set<string>();
  private plan = "";

  constructor(out: Stream, err: Stream, opts: { verbosity?: Verbosity; style?: Style; replay?: boolean } = {}) {
    this.out = out;
    this.err = err;
    this.style = opts.style ?? styleFor(err);
    this.verbosity = opts.verbosity ?? 0;
    this.replay = opts.replay ?? false;
    this.words = out.isTTY ? out : this.verbosity > 0 ? err : undefined;
    this.status = new StatusLine(this.verbosity === 0 && err.isTTY && !this.replay ? err : { write: () => undefined }, this.style);
    this.status.draw();
  }

  event(e: StreamEvent): void {
    if (e.event === "delta") {
      if (!this.words) return;
      if (this.streaming !== e.data.item_id) { this.endStream(); this.streaming = e.data.item_id; }
      this.write(this.words, e.data.text);
      this.status.set("writing");
      return;
    }
    if (e.event === "item") this.item(e.data);
  }

  private item(item: Item): void {
    const { dim, red, yellow } = this.style;
    const v = this.verbosity;
    const pad = item.parent_id ? "    " : "  ";
    switch (item.type) {
      case "message": {
        if (item.role !== "agent" || item.status !== "completed") return;
        const text = item.content.map((p) => (p.kind === "text" ? p.text : "")).join("").trim();
        if (item.parent_id) {
          if (v >= 2 && text) this.step(indent(dim(text), pad));
          return;
        }
        this.shown = text;
        if (this.streaming === item.id) { this.endStream(); return; }
        if (this.words && text) { this.endStream(); this.line(this.words, text); }
        return;
      }
      case "action": {
        const what = summary(item.action);
        if (item.status === "awaiting_approval") { this.awaiting.add(item.id); this.status.erase(true); return; }
        if (this.awaiting.delete(item.id) && !this.awaiting.size) this.status.release();
        if (item.status === "denied") this.denied.add(item.id);
        this.status.set(what);
        if (v === 0) return;
        if (item.status === "failed") {
          const exit = item.outcome?.exit_code;
          this.step(`${pad}${red("✗")} ${dim(what)}${exit !== undefined ? red(` · exit ${exit}`) : ""}`);
        } else if (item.status === "denied") {
          this.step(`${pad}${yellow("⊘")} ${dim(what)}${yellow(` · ${item.reason ?? "denied"}`)}`);
        } else if (!this.seen.has(item.id)) {
          this.step(`${pad}${dim(`▸ ${what}`)}`);
        }
        if (v >= 2 && (item.status === "completed" || item.status === "failed")) {
          for (const line of diffLines(item.action, this.style, `${pad}  `)) this.step(line);
          if (item.outcome?.excerpt) this.step(indent(dim(lastLines(item.outcome.excerpt, 6)), `${pad}  `));
        }
        this.seen.add(item.id);
        return;
      }
      case "question":
        if (item.status === "awaiting_answer") { this.awaiting.add(item.id); this.status.erase(true); }
        else if (this.awaiting.delete(item.id) && !this.awaiting.size) this.status.release();
        return;
      case "plan": {
        const done = item.steps.filter((s) => s.status === "completed").length;
        const current = item.steps.find((s) => s.status === "in_progress");
        const text = `plan ${done}/${item.steps.length}${current ? ` · ${current.text}` : done === item.steps.length ? " · done" : ""}`;
        this.status.set(text);
        if (v >= 1 && item.steps.length && text !== this.plan) { this.plan = text; this.step(`${pad}${dim(text)}`); }
        return;
      }
      case "reasoning":
        this.status.set("thinking");
        if (v >= 2) this.step(indent(dim(`thinking: ${lastLines(item.text, 12)}`), pad));
        return;
      case "notice":
        this.status.set(item.text);
        if (v >= 1) this.step(`${pad}${yellow(`! ${item.text}`)}`);
        return;
    }
  }

  /** The answer (stdout, unless it is already there), then what the caller needs to know (stderr). */
  finish(run: Run): void {
    const { dim, green, red, yellow, bold } = this.style;
    this.status.stop();
    this.endStream();
    const onScreen = this.words === this.out && run.result?.kind === "text" && run.result.text.trim() === this.shown;
    if (run.result && !onScreen) this.line(this.out, run.result.kind === "text" ? run.result.text.trimEnd() : JSON.stringify(run.result.data, null, 2));
    const took = run.ended_at ? duration(Date.parse(run.ended_at) - Date.parse(run.created_at)) : undefined;
    const lines: string[] = [];
    if (run.status === "failed" && run.error) {
      lines.push(`${red("✗")} ${bold(run.error.message)}${dim(` · ${run.error.code}${took ? ` · ${took}` : ""}`)}`, dim(`  ${ERROR_HINTS[run.error.code]}`));
    } else if (run.status === "cancelled") {
      lines.push(`${yellow("⊘")} ${bold("cancelled")}${took ? dim(` · ${took}`) : ""}`);
    }
    if (this.verbosity === 0 && this.denied.size) {
      lines.push(yellow(`⊘ ${this.denied.size} action${this.denied.size === 1 ? " was" : "s were"} denied`) + dim(" (-v shows them)"));
    }
    if (this.verbosity >= 1) {
      const u = run.usage;
      const spend = [
        run.model, took,
        u.input_tokens || u.output_tokens ? `${count(u.input_tokens)} in${u.cached_input_tokens ? ` (${count(u.cached_input_tokens)} cached)` : ""} · ${count(u.output_tokens)} out` : undefined,
        u.cost_usd !== undefined ? usd(u.cost_usd) : undefined,
      ].filter(Boolean).join(" · ");
      if (run.status === "completed") lines.push(`${green("✓")} ${bold("done")}${spend ? dim(` · ${spend}`) : ""}`);
      else if (run.status === "failed" && spend) lines.push(dim(`  ${spend}`));
      if (run.session_id && run.status !== "cancelled" && !this.replay) lines.push(dim("  continue: bo run -c \"…\""));
      if (this.verbosity >= 2) lines.push(dim(`  run ${run.id}${run.session_id ? ` · session ${run.session_id}` : ""}`));
    }
    if (!lines.length) return;
    if (this.printed) this.err.write("\n");
    for (const l of lines) this.err.write(`${l}\n`);
  }

  private step(line: string): void {
    this.endStream();
    this.line(this.err, line);
  }

  private line(stream: Stream, s: string): void {
    this.write(stream, `${s}\n`);
  }

  /** Every write goes through here: the status line is erased first and redrawn once both streams sit at a line start. */
  private write(stream: Stream, s: string): void {
    if (!s) return;
    this.status.erase();
    stream.write(s);
    if (stream === this.err) this.printed = true;
    this.atLineStart.set(stream, s.endsWith("\n"));
    if ([...this.atLineStart.values()].every(Boolean)) this.status.draw();
  }

  private endStream(): void {
    if (this.streaming && this.words && this.atLineStart.get(this.words) === false) this.write(this.words, "\n");
    this.streaming = undefined;
  }
}

/** `bo show`: a session's stored runs, each introduced by its prompt, rendered as `bo run` renders a live one. */
export function showSession(runs: readonly SessionRun[], out: Stream, opts: { verbosity: Verbosity; style: Style }): void {
  runs.forEach(({ run, items }, i) => {
    const prompt = items.find((it) => it.type === "message" && it.role === "user");
    const text = prompt?.type === "message" ? prompt.content.map((p) => (p.kind === "text" ? p.text : `[${p.kind}]`)).join(" ") : "";
    out.write(`${i ? "\n" : ""}${opts.style.dim(`› ${text.trim().split("\n", 1)[0] ?? ""}`)}\n`);
    const view = new RunView(out, out, { ...opts, replay: true });
    for (const item of items) view.event({ event: "item", id: 0, data: item });
    view.finish(run);
  });
}

function lastLines(s: string, n: number): string {
  const lines = s.trimEnd().split("\n");
  return lines.length > n ? `…\n${lines.slice(-n).join("\n")}` : lines.join("\n");
}

function indent(s: string, pad: string): string {
  return s.split("\n").map((l) => `${pad}${l}`).join("\n");
}

/** The prompt for an action awaiting approval: what it is (an edit shows its diff), then the choices. */
export function approvalPrompt(item: Extract<Item, { type: "action" }>, style: Style): string {
  const { bold, dim, cyan } = style;
  const diff = diffLines(item.action, style, "    ");
  return `${cyan("?")} ${bold("allow")} ${summary(item.action)}${item.reason ? dim(`  (${item.reason})`) : ""}\n`
    + (diff.length ? `${diff.join("\n")}\n` : "")
    + `  ${dim("[y] yes  [a] yes, for the rest of this run  [n] no")} ${cyan("›")} `;
}

const DIFF_LINES = 40;

/** An edit's diffs, coloured, at most 40 lines per change. */
function diffLines(action: Action, style: Style, pad: string): string[] {
  if (action.kind !== "edit") return [];
  const out: string[] = [];
  for (const change of action.changes) {
    if (!change.diff) continue;
    const all = change.diff.trimEnd().split("\n");
    if (action.changes.length > 1) out.push(`${pad}${style.dim(change.path)}`);
    for (const line of all.slice(0, DIFF_LINES)) {
      const paint = line.startsWith("+") ? style.green : line.startsWith("-") ? style.red : style.dim;
      out.push(`${pad}${paint(line)}`);
    }
    if (all.length > DIFF_LINES) out.push(`${pad}${style.dim(`… ${all.length - DIFF_LINES} more lines`)}`);
  }
  return out;
}

export function questionPrompt(q: { text: string; options?: string[]; multiple: boolean }, style: Style): string {
  const { bold, dim, cyan } = style;
  const options = q.options?.map((o, i) => `  ${dim(`${i + 1}.`)} ${o}\n`).join("") ?? "";
  const how = q.options?.length ? (q.multiple ? "numbers or text, comma-separated" : "a number or text") : "your answer";
  return `${cyan("?")} ${bold(q.text)}\n${options}  ${dim(how)} ${cyan("›")} `;
}

/** `bo engines`: one block per engine, models as an aligned table. */
export function enginesTable(engines: readonly EngineInfo[], style: Style): string {
  const { bold, dim, green, red } = style;
  const blocks = engines.map((e) => {
    const head = e.available
      ? `${green("●")} ${bold(e.id)} ${dim(`${e.version ?? ""} · ${e.authentication}`)}`
      : `${red("○")} ${bold(e.id)} ${dim("unavailable")}`;
    if (!e.available) return `${head}\n  ${e.reason ?? "no reason given"}`;
    const rows = e.models.map((m) => [
      `${m.id}${m.default ? " (default)" : ""}`,
      m.aliases.join(", ") || "–",
      m.efforts.join(" ") || "–",
      m.images ? "" : "no images",
    ]);
    const table = columns([["model", "aliases", "effort", ""], ...rows], "  ", (row, i) => (i === 0 ? dim(row) : row));
    return `${head}\n${table}`;
  });
  return `${blocks.join("\n\n")}\n`;
}

/** `bo runs`: newest active first. */
export function runsTable(runs: readonly Run[], style: Style, now = Date.now()): string {
  const { dim, green, red, yellow, cyan } = style;
  if (!runs.length) return `${dim("no runs (finished runs are kept for 10 minutes)")}\n`;
  const paint = (status: Run["status"]) => ({ completed: green, failed: red, cancelled: yellow, running: cyan, waiting: cyan })[status](status);
  const rows = runs.map((r) => [r.id, r.status, r.engine.id, r.model ?? "–", `${duration(now - Date.parse(r.created_at))} ago`]);
  return `${columns([["run", "status", "engine", "model", "started"], ...rows], "", (row, i) => (i === 0 ? dim(row) : row), (cell, col, i) => (col === 1 && i > 0 ? paint(cell as Run["status"]) : cell))}\n`;
}

/** `bo sessions`: newest first, with what continues each. */
export function sessionsTable(sessions: readonly Session[], style: Style, opts: { workspace?: string; now?: number } = {}): string {
  const { dim } = style;
  const now = opts.now ?? Date.now();
  if (!sessions.length) {
    return `${dim(opts.workspace ? `no sessions in ${opts.workspace} yet; \`bo run "…"\` starts one` : "no sessions yet")}\n`;
  }
  const rows = sessions.map((s) => [
    s.title, s.engine, s.model ?? "–", String(s.runs), spent(s.usage), `${duration(now - Date.parse(s.updated_at))} ago`,
    ...(opts.workspace ? [] : [s.workspace]), s.id,
  ]);
  const head = ["session", "engine", "model", "runs", "tokens", "last used", ...(opts.workspace ? [] : ["workspace"]), "id"];
  const table = columns([head, ...rows], "", (row, i) => (i === 0 ? dim(row) : row), (cell, col, i) => (i > 0 && col === head.length - 1 ? dim(cell) : cell));
  return `${table}\n${dim(opts.workspace ? "  bo run -c continues the newest; bo run --session <id> any other" : "")}${opts.workspace ? "\n" : ""}`;
}

/** `12.4k in · 830 out · $0.0412`, or `–` when nothing was spent. */
function spent(u: Usage): string {
  if (!u.input_tokens && !u.output_tokens) return "–";
  return `${count(u.input_tokens)} in · ${count(u.output_tokens)} out${u.cost_usd !== undefined ? ` · ${usd(u.cost_usd)}` : ""}`;
}

/** `bo config`: every setting, its effective value, and where that value comes from. */
export function configTable(rows: readonly { key: string; value: unknown; source: string }[], file: string, token: string | undefined, style: Style): string {
  const { dim } = style;
  const shown = rows.map((r) => [r.key, r.value === undefined ? "–" : String(r.value), r.value === undefined ? "decided by the server or engine" : r.source]);
  shown.push(["token", token ? "set" : "–", token ?? "BO_TOKEN or --token (never read from the file)"]);
  return `${dim(`config ${file}`)}\n${columns([["setting", "value", "source"], ...shown], "", (row, i) => (i === 0 ? dim(row) : row), (cell, col) => (col === 2 ? dim(cell) : cell))}\n`;
}

/** Left-aligned columns; `paintCell` colours a cell after padding is computed on its plain text. */
function columns(
  rows: string[][], indentBy: string, paintRow: (row: string, i: number) => string,
  paintCell: (cell: string, col: number, i: number) => string = (c) => c,
): string {
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((r) => (r[col] ?? "").length)));
  return rows.map((r, i) => paintRow(`${indentBy}${r.map((cell, col) => {
    const padded = col === r.length - 1 ? cell : cell.padEnd(widths[col]!);
    return paintCell(cell, col, i) + padded.slice(cell.length);
  }).join("  ").trimEnd()}`, i)).join("\n");
}

/** What to do next, by problem type. */
const PROBLEM_HINTS: Partial<Record<string, string>> = {
  engine_unavailable: "`bo engines` shows each engine's state",
  unsupported_feature: "`bo engines` shows which models accept images",
  unauthorized: "pass --token or set BO_TOKEN",
  too_many_runs: "wait for a run to finish (`bo runs`), or start the server with a higher --max-runs",
  session_busy: "that session has a run in progress (`bo runs`)",
  run_not_found: "finished runs are kept for 10 minutes",
  forbidden_host: "connect through 127.0.0.1 or localhost, or give the server a token",
};

/** A server problem as `bo: detail`, each field error on its own line, then a hint. */
export function problemText(p: Problem, style: Style): string {
  const { dim, red } = style;
  const name = p.type.slice("urn:bo:problem:".length);
  const fields = (p.errors ?? []).map((e) => `  ${red(fieldName(e.pointer))}  ${e.detail}\n`).join("");
  const hint = PROBLEM_HINTS[name];
  return `${red("bo:")} ${p.detail}\n${fields}${hint ? dim(`  ${hint}\n`) : ""}`;
}

/** `/subagents/helper/model` → `subagents.helper.model`. */
function fieldName(pointer: string): string {
  return pointer ? pointer.slice(1).split("/").map((t) => t.replaceAll("~1", "/").replaceAll("~0", "~")).join(".") : "(request)";
}

export function errorText(message: string, hint: string | undefined, style: Style): string {
  return `${style.red("bo:")} ${message}\n${hint ? style.dim(`  ${hint}\n`) : ""}`;
}
