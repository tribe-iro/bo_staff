// The session index: which conversations exist, per workspace. The engines keep the conversations themselves; bo keeps
// only what it needs to list them and to continue the latest one. Persisted as one small JSON file (mode 0600: titles
// are prompt text), rewritten atomically; an unreadable file starts an empty index instead of failing the server.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ENGINE_IDS, type EngineId, type Part, type Session } from "../model.ts";
import { silent, type Logger } from "../log.ts";

/** Sessions kept per workspace and in all; the oldest leave the index (the engine's own history is untouched). */
const PER_WORKSPACE = 50;
const TOTAL = 2_000;
const TITLE_CHARS = 80;

interface Entry extends Session {
  /** The A2A context the session belongs to, when it began there. */
  context?: string;
}

/** Which session "latest" means: in a workspace (optionally for one engine), or in an A2A context. */
export type LatestQuery = { workspace: string; engine?: EngineId } | { context: string };

export interface SessionLookup {
  latest(q: LatestQuery): Session | undefined;
}

/** What a run tells the index about its session. */
export interface SessionNote {
  id: string;
  engine: EngineId;
  workspace: string;
  input: readonly Part[];
  model?: string | null;
  context?: string;
  /** The run ended: count it. */
  ended?: boolean;
}

export class SessionIndex implements SessionLookup {
  /** Least recently used first: every note re-inserts its entry, so iteration order is recency order. */
  private readonly entries = new Map<string, Entry>();
  private readonly file: string | undefined;
  private readonly log: Logger;
  private saving: Promise<void> = Promise.resolve();

  private constructor(file: string | undefined, log: Logger) {
    this.file = file;
    this.log = log;
  }

  /** An index that lives in memory only. */
  static memory(): SessionIndex {
    return new SessionIndex(undefined, silent);
  }

  /** An index persisted at `file`, loaded now. */
  static async open(file: string, log: Logger = silent): Promise<SessionIndex> {
    const index = new SessionIndex(file, log);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return index;   // first start
    }
    try {
      const loaded = (JSON.parse(raw) as { sessions: Entry[] }).sessions.filter(isEntry);
      for (const entry of loaded.sort((a, b) => a.updated_at.localeCompare(b.updated_at))) index.entries.set(entry.id, entry);
    } catch (err) {
      log(`session index ${file} is unreadable; starting empty (${err instanceof Error ? err.message : String(err)})`);
    }
    return index;
  }

  latest(q: LatestQuery): Session | undefined {
    const match = (e: Entry) => ("context" in q ? e.context === q.context : e.workspace === q.workspace && (!q.engine || e.engine === q.engine));
    const found = [...this.entries.values()].findLast(match);
    return found && publicSession(found);
  }

  /** Most recently used first; one workspace, or all. */
  list(workspace?: string): Session[] {
    return [...this.entries.values()].filter((e) => workspace === undefined || e.workspace === workspace).reverse().map(publicSession);
  }

  note(n: SessionNote): void {
    const now = new Date().toISOString();
    const entry = this.entries.get(n.id) ?? {
      id: n.id, engine: n.engine, workspace: n.workspace, title: titleOf(n.input), model: null, runs: 0, created_at: now, updated_at: now,
      ...(n.context ? { context: n.context } : {}),
    };
    entry.updated_at = now;
    if (n.model) entry.model = n.model;
    if (n.ended) entry.runs++;
    this.entries.delete(n.id);
    this.entries.set(n.id, entry);
    this.evict(entry.workspace);
    this.save();
  }

  /** Resolves once every change so far is on disk. */
  flush(): Promise<void> {
    return this.saving;
  }

  private evict(workspace: string): void {
    dropOldest([...this.entries.values()].filter((e) => e.workspace === workspace), PER_WORKSPACE, this.entries);
    dropOldest([...this.entries.values()], TOTAL, this.entries);
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
      } catch (err) {
        this.log(`session index ${file} not saved: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }
}

/** `entries` are least recently used first. */
function dropOldest(entries: Entry[], keep: number, from: Map<string, Entry>): void {
  for (const e of entries.slice(0, Math.max(0, entries.length - keep))) from.delete(e.id);
}

function titleOf(input: readonly Part[]): string {
  const text = input.find((p): p is Extract<Part, { kind: "text" }> => p.kind === "text")?.text.trim() ?? "";
  const line = text.split("\n", 1)[0] ?? "";
  if (!line) return input.some((p) => p.kind === "image") ? "(image)" : "(data)";
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
}

function publicSession({ context: _context, ...session }: Entry): Session {
  return { ...session };
}

function isEntry(v: unknown): v is Entry {
  const e = v as Entry;
  return typeof e === "object" && e !== null && typeof e.id === "string" && ENGINE_IDS.includes(e.engine)
    && typeof e.workspace === "string" && typeof e.title === "string" && typeof e.runs === "number"
    && typeof e.created_at === "string" && typeof e.updated_at === "string";
}
