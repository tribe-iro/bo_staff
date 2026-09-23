// Server log: one line per event (`HH:MM:SS  message`), optional indented detail lines beneath it.

import { styleFor, type Stream } from "./render.ts";

export type Logger = (message: string, detail?: readonly string[]) => void;

export const silent: Logger = () => {};

export function streamLogger(stream: Stream = process.stderr, now: () => Date = () => new Date()): Logger {
  const { dim } = styleFor(stream);
  return (message, detail = []) => {
    const time = now().toTimeString().slice(0, 8);
    stream.write(`${dim(time)}  ${message}\n${detail.map((line) => dim(`          ${line}`)).join("\n")}${detail.length ? "\n" : ""}`);
  };
}

const MAX_LINES = 40;
/** Field names whose values never reach the log. */
const SECRET_KEY = /authorization|(^|[_-])token$|secret|password|passwd|api[_-]?key|cookie|credential|^env$|^headers$/i;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g;
const MAX_LINE = 400;

/**
 * An engine diagnostic as readable lines: errors as `Name: message` (with their cause), multi-line strings (stderr
 * tails) as their last lines, anything else as compact JSON. Bounded, whatever the input.
 */
export function describe(value: unknown): string[] {
  const lines: string[] = [];
  const add = (line: string) => {
    const safe = line.replace(BEARER, "$1 [redacted]");
    lines.push(safe.length > MAX_LINE ? `${safe.slice(0, MAX_LINE)} …` : safe);
  };
  const walk = (v: unknown, label: string, depth: number): void => {
    if (v === undefined || v === null || v === "") return;
    const prefix = label ? `${label}: ` : "";
    if (SECRET_KEY.test(label.split(".").at(-1) ?? "")) { add(`${prefix}[redacted]`); return; }
    if (v instanceof Error) {
      add(`${prefix}${v.name}: ${v.message}`);
      if (v.cause !== undefined && depth < 3) walk(v.cause, "cause", depth + 1);
    } else if (typeof v === "string") {
      const text = v.trimEnd().split("\n");
      if (text.length === 1) add(`${prefix}${text[0]}`);
      else {
        add(`${label || "output"} (last lines):`);
        for (const line of text.slice(-15)) add(`  ${line}`);
      }
    } else if (typeof v === "object" && depth < 2 && !Array.isArray(v)) {
      for (const [k, child] of Object.entries(v)) walk(child, label ? `${label}.${k}` : k, depth + 1);
    } else {
      add(`${prefix}${JSON.stringify(v)}`);
    }
  };
  walk(value, "", 0);
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `… ${lines.length - MAX_LINES} more lines`] : lines;
}
