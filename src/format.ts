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
    case "edit": return `${a.changes.every((c) => c.change === "add") ? "create" : a.changes.every((c) => c.change === "delete") ? "delete" : "edit"} ${a.changes.map((c) => c.path).join(", ")}`;
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
