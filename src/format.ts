// Plain-text formatting shared by the terminal (render.ts) and the server log: numbers, durations, actions.

import type { Action } from "./model.ts";

/** 950 → "950", 11131 → "11.1k", 2_400_000 → "2.4M". */
export function count(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trim1(n / 1000)}k`;
  return `${trim1(n / 1_000_000)}M`;
}

function trim1(x: number): string {
  return x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, "");
}

/** 0.0412 → "$0.0412", 12.3 → "$12.30". */
export function usd(amount: number): string {
  return `$${amount.toFixed(amount < 1 ? 4 : 2)}`;
}

/** 8_000 → "8s", 125_000 → "2m 05s", 3_720_000 → "1h 02m". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

export function summary(a: Action): string {
  switch (a.kind) {
    case "shell": return `$ ${firstLine(a.command)}`;
    case "read": return `read ${a.paths.join(", ")}`;
    case "edit": {
      const verb = a.changes.every((c) => c.change === "add") ? "create" : a.changes.every((c) => c.change === "delete") ? "delete" : "edit";
      const diffs = a.changes.filter((c) => c.diff);
      const stat = diffs.reduce((s, c) => { const d = diffStat(c.diff!); return { added: s.added + d.added, removed: s.removed + d.removed }; }, { added: 0, removed: 0 });
      return `${verb} ${a.changes.map((c) => c.path).join(", ")}${diffs.length ? ` (+${stat.added} −${stat.removed})` : ""}`;
    }
    case "search": return `search ${a.query}`;
    case "web": return a.url ? `fetch ${a.url}` : `web search ${a.query ?? ""}`;
    case "mcp": return `${a.server} · ${a.tool}`;
    case "delegate": return `${a.subagent ?? "subagent"} ← ${firstLine(a.task)}`;
    case "skill": return `skill ${a.name}`;
    case "other": return a.name;
  }
}

function firstLine(s: string): string {
  const line = s.trim().split("\n", 1)[0] ?? "";
  return line.length < s.trim().length ? `${line} …` : line;
}

// Diffs: unified hunks without file headers. Every hunk starts with `@@ -a,b +c,d @@`, or `@@ @@` when line numbers are
// unknown (an edit awaiting approval). At most 64 KiB per change.

const DIFF_BYTES = 64 * 1024;
const TRUNCATED = "\\ diff truncated\n";

function lines(text: string): string[] {
  if (!text) return [];
  const all = text.split("\n");
  if (all.at(-1) === "") all.pop();
  return all;
}

/** A new file's content as one hunk. */
export function addHunk(content: string): string {
  const added = lines(content);
  return added.length ? `@@ -0,0 +1,${added.length} @@\n${added.map((l) => `+${l}`).join("\n")}\n` : "";
}

/** A deleted file's content as one hunk. */
export function deleteHunk(content: string): string {
  const removed = lines(content);
  return removed.length ? `@@ -1,${removed.length} +0,0 @@\n${removed.map((l) => `-${l}`).join("\n")}\n` : "";
}

/** A text replacement whose position is not known yet. */
export function replaceHunk(before: string, after: string): string {
  return `@@ @@\n${[...lines(before).map((l) => `-${l}`), ...lines(after).map((l) => `+${l}`)].join("\n")}\n`;
}

export interface PatchHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

/** Structured hunks (lines already prefixed with ` `, `-`, `+`) as diff text. */
export function patchHunks(hunks: readonly PatchHunk[]): string {
  return hunks.map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.map((l) => `${l}\n`).join("")}`).join("");
}

/** At most 64 KiB: the whole hunks that fit (a first hunk larger than that is cut by lines), then a marker. */
export function capDiff(diff: string): string {
  if (Buffer.byteLength(diff) <= DIFF_BYTES) return diff;
  const budget = DIFF_BYTES - Buffer.byteLength(TRUNCATED);
  let out = "";
  let size = 0;
  let atHunk = false;   // the first line that did not fit starts a hunk: `out` already ends on a whole hunk
  for (const line of diff.split(/(?<=\n)/)) {
    const bytes = Buffer.byteLength(line);
    if (size + bytes > budget) { atHunk = line.startsWith("@@"); break; }
    out += line;
    size += bytes;
  }
  const lastHunk = out.lastIndexOf("\n@@");
  if (!atHunk && lastHunk > 0) out = out.slice(0, lastHunk + 1);
  return `${out}${TRUNCATED}`;
}

/** Added and removed lines. */
export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+")) added++;
    else if (l.startsWith("-")) removed++;
  }
  return { added, removed };
}

// ---- streamed text ----
// Delta offsets count Unicode code points, so every client language agrees on them.

export function codePoints(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0xdc00 || c > 0xdfff) n++;   // a low surrogate completes the code point its high surrogate started
  }
  return n;
}

/** `text` without its first `n` code points. */
export function dropCodePoints(text: string, n: number): string {
  let i = 0;
  for (let seen = 0; seen < n && i < text.length; seen++) {
    const c = text.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < text.length ? 2 : 1;
  }
  return text.slice(i);
}
