// bo's settings: one table of keys drives the config file, the environment, precedence, and `bo config`.
// Precedence: flag > environment > config file > built-in default. Secrets never come from the file.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { ACCESS_LEVELS, ENGINE_IDS, type Access, type EngineId } from "./model.ts";
import { configDir } from "./paths.ts";

type Kind =
  | { type: "string" }
  | { type: "enum"; values: readonly string[] }
  | { type: "int"; min: number; max: number }
  | { type: "bool" };

interface KeySpec<T> {
  kind: Kind;
  /** Environment variable that sets it. */
  env?: string;
  /** Built-in default; absent means "decided elsewhere" (by the server or the engine). */
  fallback?: T;
}

/** Every setting, by its dotted name in config.toml. */
export interface Values {
  url: string;
  "run.engine": EngineId;
  "run.model": string;
  "run.effort": string;
  "run.access": Access;
  "run.verbose": number;
  "serve.host": string;
  "serve.port": number;
  "serve.max_runs": number;
  "serve.default_engine": EngineId;
  "serve.allow_subscription_auth": boolean;
}

export type Key = keyof Values;

const STRING: Kind = { type: "string" };
const ENGINE: Kind = { type: "enum", values: ENGINE_IDS };

const KEYS: { [K in Key]: KeySpec<Values[K]> } = {
  url: { kind: STRING, env: "BO_URL", fallback: "http://127.0.0.1:3000" },
  "run.engine": { kind: ENGINE },
  "run.model": { kind: STRING },
  "run.effort": { kind: STRING },
  "run.access": { kind: { type: "enum", values: ACCESS_LEVELS } },
  "run.verbose": { kind: { type: "int", min: 0, max: 2 }, fallback: 0 },
  "serve.host": { kind: STRING, env: "HOST", fallback: "127.0.0.1" },
  "serve.port": { kind: { type: "int", min: 0, max: 65_535 }, env: "PORT", fallback: 3000 },
  "serve.max_runs": { kind: { type: "int", min: 1, max: 1_000 }, env: "BO_MAX_RUNS", fallback: 8 },
  "serve.default_engine": { kind: ENGINE, env: "BO_DEFAULT_ENGINE" },
  "serve.allow_subscription_auth": { kind: { type: "bool" }, env: "BO_ALLOW_SUBSCRIPTION_AUTH", fallback: false },
};

export type Source = "flag" | `env ${string}` | "config.toml" | "default";

export interface Resolved<T> { value: T | undefined; source: Source }

/** A config file or environment value that cannot be used; the message names where it came from. */
export class ConfigError extends Error {}

export class Config {
  readonly file: string;
  readonly exists: boolean;
  private readonly values: Partial<Values>;
  private readonly env: NodeJS.ProcessEnv;

  private constructor(file: string, exists: boolean, values: Partial<Values>, env: NodeJS.ProcessEnv) {
    this.file = file;
    this.exists = exists;
    this.values = values;
    this.env = env;
  }

  /** The environment and `$XDG_CONFIG_HOME/bo/config.toml` (absent is fine; malformed is a `ConfigError`). */
  static async load(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
    const file = path.join(configDir(env), "config.toml");
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Config(file, false, {}, env);
      throw new ConfigError(`${file}: ${(err as Error).message}`);
    }
    let doc: Record<string, unknown>;
    try {
      doc = parseToml(text) as Record<string, unknown>;
    } catch (err) {
      throw new ConfigError(`${file}: ${(err as Error).message.split("\n", 1)[0]}`);
    }
    return new Config(file, true, fromDocument(doc, file), env);
  }

  /** The environment only (library use, tests). */
  static fromEnv(env: NodeJS.ProcessEnv): Config {
    return new Config("", false, {}, env);
  }

  get<K extends Key>(key: K, flag?: Values[K]): Resolved<Values[K]> {
    if (flag !== undefined) return { value: flag, source: "flag" };
    const spec = KEYS[key] as KeySpec<Values[K]>;
    const raw = spec.env ? this.env[spec.env] : undefined;
    if (spec.env && raw !== undefined && raw !== "") {
      const value = fromString(spec.kind, raw) as Values[K] | undefined;
      if (value === undefined) throw new ConfigError(`${spec.env} ${describeKind(spec.kind)}`);
      return { value, source: `env ${spec.env}` };
    }
    if (this.values[key] !== undefined) return { value: this.values[key] as Values[K], source: "config.toml" };
    return { value: spec.fallback, source: "default" };
  }

  /** Every key's effective value and source (`bo config`). */
  explain(flags: Partial<Values> = {}): { key: Key; value: unknown; source: Source }[] {
    return (Object.keys(KEYS) as Key[]).map((key) => ({ key, ...this.get(key, flags[key] as never) }));
  }
}

/** Validates a parsed config.toml against the key table: unknown keys and wrong types name the file and key. */
function fromDocument(doc: Record<string, unknown>, file: string): Partial<Values> {
  const out: Record<string, unknown> = {};
  const visit = (table: Record<string, unknown>, prefix: string): void => {
    for (const [name, value] of Object.entries(table)) {
      const key = prefix ? `${prefix}.${name}` : name;
      if (value !== null && typeof value === "object" && !Array.isArray(value) && !(key in KEYS)) {
        if (prefix || !["run", "serve"].includes(name)) throw new ConfigError(`${file}: unknown table [${key}]`);
        visit(value as Record<string, unknown>, key);
        continue;
      }
      const spec = KEYS[key as Key] as KeySpec<unknown> | undefined;
      if (!spec) throw new ConfigError(`${file}: unknown key ${key}`);
      if (!fits(spec.kind, value)) throw new ConfigError(`${file}: ${key} ${describeKind(spec.kind)}`);
      out[key] = value;
    }
  };
  visit(doc, "");
  return out as Partial<Values>;
}

function fits(kind: Kind, v: unknown): boolean {
  switch (kind.type) {
    case "string": return typeof v === "string" && v !== "";
    case "enum": return typeof v === "string" && kind.values.includes(v);
    case "int": return typeof v === "number" && Number.isInteger(v) && v >= kind.min && v <= kind.max;
    case "bool": return typeof v === "boolean";
  }
}

function fromString(kind: Kind, raw: string): unknown {
  switch (kind.type) {
    case "string": return raw;
    case "enum": return kind.values.includes(raw) ? raw : undefined;
    case "int": { const n = Number(raw); return fits(kind, n) ? n : undefined; }
    case "bool": return raw === "1" || raw === "true" ? true : raw === "0" || raw === "false" ? false : undefined;
  }
}

function describeKind(kind: Kind): string {
  switch (kind.type) {
    case "string": return "must be a non-empty string";
    case "enum": return `must be one of ${kind.values.join(", ")}`;
    case "int": return `must be an integer ${kind.min}–${kind.max}`;
    case "bool": return "must be true or false (1 or 0 in the environment)";
  }
}
