// The session index: which conversations exist, per workspace. The engines keep the conversations themselves; bo keeps
// only what it needs to list them and to continue the latest one. Persisted as one small JSON file (mode 0600: titles
// are prompt text), rewritten atomically. A damaged index is preserved for repair instead of being overwritten.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ENGINE_IDS, type EngineId, type Part, type Session, type SessionRun, type Usage } from "../model.ts";
import { FileHistory, MemoryHistory, type HistoryStore } from "./history.ts";
import { addUsage, ZERO_USAGE } from "../harness/port.ts";
import { isMissingFile } from "../fs.ts";
import { silent, type Logger } from "../log.ts";
import { problem, type Problem } from "../problems.ts";

/** Sessions kept per workspace and in all; the oldest leave the index (the engine's own history is untouched). */
const PER_WORKSPACE = 50;
const TOTAL = 2_000;
const TITLE_CHARS = 80;

interface Entry extends Session {
  /** The engine's own running totals after the last run (the next run's usage baseline); never public. */
  engineTotals?: Usage;
}

/** Which session "latest" means: in a workspace (optionally for one engine), or the one with a key in a workspace. */
export type LatestQuery = { workspace: string; engine?: EngineId } | { workspace: string; key: string };

export interface SessionLookup {
  latest(q: LatestQuery): Session | undefined;
  get(id: string): Session | undefined;
  /** The engine's running totals as of the session's last run, if the engine keeps any. */
  totals(id: string): Usage | undefined;
}

/** What a run tells the index about its session. */
export interface SessionNote {
  id: string;
  engine: EngineId;
  workspace: string;
  input: readonly Part[];
  model?: string | null;
  /** The caller-chosen key the session was started with. */
  key?: string;
  /** The run ended: count it and add its usage. */
  ended?: { usage: Usage; totals?: Usage };
}

export function sessionNotFound(id: string): Problem {
  return problem("session_not_found", `no session ${id} (bo keeps up to 50 sessions per workspace)`);
}

export class SessionIndex implements SessionLookup {
  /** Least recently used first: every note re-inserts its entry, so iteration order is recency order. */
  private readonly entries = new Map<string, Entry>();
  private readonly file: string | undefined;
  private readonly log: Logger;
  private readonly history: HistoryStore;
  private saving: Promise<void> = Promise.resolve();
  /** Why the index on disk is behind memory: the last save failed (each save writes the whole index, so the next one catches up). */
  private unsaved?: Error;

  private constructor(file: string | undefined, history: HistoryStore, log: Logger) {
    this.file = file;
    this.history = history;
    this.log = log;
  }

  /** An index (and history) that lives in memory only. */
  static memory(): SessionIndex {
    return new SessionIndex(undefined, new MemoryHistory(), silent);
  }

  /** An index persisted at `file`, loaded now; each session's history lives in `history/` next to it. */
  static async open(file: string, log: Logger = silent): Promise<SessionIndex> {
    const index = new SessionIndex(file, new FileHistory(path.join(path.dirname(file), "history"), log), log);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (err) {
      if (isMissingFile(err)) return index;   // first start
      throw err;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isIndex(parsed)) throw new Error("invalid session index structure");
      const loaded = parsed.sessions;
      for (const entry of loaded.sort((a, b) => a.updated_at.localeCompare(b.updated_at))) index.entries.set(entry.id, entry);
    } catch (err) {
      throw new Error(`session index ${file} is unreadable: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    return index;
  }

  latest(q: LatestQuery): Session | undefined {
    const match = (e: Entry) => e.workspace === q.workspace && ("key" in q ? e.key === q.key : !q.engine || e.engine === q.engine);
    const found = [...this.entries.values()].findLast(match);
    return found && publicSession(found);
  }

  get(id: string): Session | undefined {
    const entry = this.entries.get(id);
    return entry && publicSession(entry);
  }

  /** A finished run of an indexed session, for its history. */
  append(id: string, run: SessionRun): void {
    if (this.entries.has(id)) this.history.append(id, run);
  }

  /** The session's finished runs, oldest first. */
  runs(id: string): Promise<SessionRun[]> {
    return this.history.read(id);
  }

  /** Forgets the session and its history; `false` if it was not indexed. The engine's own history is untouched. */
  delete(id: string): boolean {
    if (!this.entries.delete(id)) return false;
    this.history.remove(id);
    this.save();
    return true;
  }

  totals(id: string): Usage | undefined {
    return this.entries.get(id)?.engineTotals;
  }

  /** Most recently used first; one workspace, or all. */
  list(workspace?: string): Session[] {
    return [...this.entries.values()].filter((e) => workspace === undefined || e.workspace === workspace).reverse().map(publicSession);
  }

  note(n: SessionNote): void {
    const now = new Date().toISOString();
    const entry: Entry = this.entries.get(n.id) ?? {
      id: n.id, engine: n.engine, workspace: n.workspace, title: titleOf(n.input), model: null, runs: 0, usage: { ...ZERO_USAGE },
      created_at: now, updated_at: now, ...(n.key ? { key: n.key } : {}),
    };
    entry.updated_at = now;
    if (n.model) entry.model = n.model;
    if (n.ended) {
      entry.runs++;
      entry.usage = addUsage(entry.usage, n.ended.usage);
      if (n.ended.totals) entry.engineTotals = n.ended.totals;
    }
    this.entries.delete(n.id);
    this.entries.set(n.id, entry);
    this.evict(entry.workspace);
    this.save();
  }

  /** Resolves once every change so far is on disk; rejects when one could not be written. */
  async flush(): Promise<void> {
    await this.saving;
    await this.history.flush();
    if (this.unsaved) throw this.unsaved;
  }

  private evict(workspace: string): void {
    const evicted = [
      ...dropOldest([...this.entries.values()].filter((e) => e.workspace === workspace), PER_WORKSPACE, this.entries),
      ...dropOldest([...this.entries.values()], TOTAL, this.entries),
    ];
    for (const id of evicted) this.history.remove(id);
  }

  /** Writes are serialized; each writes the whole (small) index to a temporary file and renames it into place. */
  private save(): void {
    const file = this.file;
    if (!file) return;
    this.saving = this.saving.then(async () => {
      const body = `${JSON.stringify({ sessions: [...this.entries.values()] }, null, 1)}\n`;
      try {
        await mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, body, { mode: 0o600 });
        await rename(tmp, file);
        this.unsaved = undefined;
      } catch (err) {
        this.unsaved = new Error(`session index ${file} not saved: ${err instanceof Error ? err.message : String(err)}`);
        this.log(this.unsaved.message);
      }
    });
  }
}

/** `entries` are least recently used first; returns the ids it removed. */
function dropOldest(entries: Entry[], keep: number, from: Map<string, Entry>): string[] {
  const dropped = entries.slice(0, Math.max(0, entries.length - keep)).map((e) => e.id);
  for (const id of dropped) from.delete(id);
  return dropped;
}

function titleOf(input: readonly Part[]): string {
  const text = input.find((p): p is Extract<Part, { kind: "text" }> => p.kind === "text")?.text.trim() ?? "";
  const line = text.split("\n", 1)[0] ?? "";
  if (!line) return input.some((p) => p.kind === "image") ? "(image)" : "(data)";
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
}

function publicSession({ engineTotals: _totals, ...session }: Entry): Session {
  return { ...session };
}

function isEntry(v: unknown): v is Entry {
  const e = v as Entry;
  return typeof e === "object" && e !== null && typeof e.id === "string" && ENGINE_IDS.includes(e.engine)
    && typeof e.workspace === "string" && typeof e.title === "string" && typeof e.runs === "number" && typeof e.usage === "object"
    && typeof e.created_at === "string" && typeof e.updated_at === "string";
}

function isIndex(v: unknown): v is { sessions: Entry[] } {
  return typeof v === "object" && v !== null && Array.isArray((v as { sessions?: unknown }).sessions)
    && (v as { sessions: unknown[] }).sessions.every(isEntry);
}
