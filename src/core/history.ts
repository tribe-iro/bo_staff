// Session history: each finished run of a session, with the final state of its items, so a session stays readable
// after its runs leave memory. One JSONL file per session (mode 0600: prompts and answers), at most 8 MiB; when an append
// goes past that, the oldest runs are dropped (the newest is always kept).

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionRun } from "../model.ts";
import { isMissingFile } from "../fs.ts";
import { silent, type Logger } from "../log.ts";

const MAX_BYTES = 8 * 1024 * 1024;

export interface HistoryStore {
  append(id: string, run: SessionRun): void;
  /** Oldest first. */
  read(id: string): Promise<SessionRun[]>;
  remove(id: string): void;
  /** Resolves once every write so far is done; rejects when one failed since the last flush (that run's history is lost). */
  flush(): Promise<void>;
}

export class MemoryHistory implements HistoryStore {
  private readonly runs = new Map<string, SessionRun[]>();

  append(id: string, run: SessionRun): void {
    this.runs.set(id, [...(this.runs.get(id) ?? []), run]);
  }

  async read(id: string): Promise<SessionRun[]> {
    return this.runs.get(id) ?? [];
  }

  remove(id: string): void {
    this.runs.delete(id);
  }

  async flush(): Promise<void> {}
}

export class FileHistory implements HistoryStore {
  private readonly dir: string;
  private readonly log: Logger;
  private readonly maxBytes: number;
  /** Every file operation runs in order: an append never races a rewrite or a removal. */
  private queue: Promise<void> = Promise.resolve();
  private failures: string[] = [];

  constructor(dir: string, log: Logger = silent, maxBytes = MAX_BYTES) {
    this.dir = dir;
    this.log = log;
    this.maxBytes = maxBytes;
  }

  append(id: string, run: SessionRun): void {
    this.enqueue(async () => {
      const file = this.file(id);
      await mkdir(this.dir, { recursive: true });
      await appendFile(file, `${JSON.stringify(run)}\n`, { mode: 0o600 });
      if ((await stat(file)).size > this.maxBytes) await this.shrink(file);
    });
  }

  async read(id: string): Promise<SessionRun[]> {
    await this.queue;
    let text: string;
    try {
      text = await readFile(this.file(id), "utf8");
    } catch (err) {
      if (isMissingFile(err)) return [];
      throw err;
    }
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as SessionRun);
  }

  remove(id: string): void {
    this.enqueue(() => rm(this.file(id), { force: true }));
  }

  async flush(): Promise<void> {
    await this.queue;
    const failures = this.failures;
    this.failures = [];
    if (failures.length) throw new Error(`session history not saved: ${failures.join("; ")}`);
  }

  /** Session ids are long and engine-derived: the file name is a hash of the id. */
  private file(id: string): string {
    return path.join(this.dir, `${createHash("sha256").update(id).digest("hex").slice(0, 32)}.jsonl`);
  }

  /** Rewrites the file without its oldest runs until it fits (the newest run is always kept), atomically. */
  private async shrink(file: string): Promise<void> {
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    let size = lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
    while (lines.length > 1 && size > this.maxBytes) size -= Buffer.byteLength(lines.shift()!) + 1;
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${lines.join("\n")}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }

  private enqueue(op: () => Promise<unknown>): void {
    this.queue = this.queue.then(op).then(() => undefined, (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.failures.push(message);
      this.log(`session history not saved: ${message}`);
    });
  }
}
