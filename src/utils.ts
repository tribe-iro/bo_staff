import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile, access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortJson(child)]);
  return Object.fromEntries(entries);
}

export function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function generateHandle(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.tmp-${randomUUID()}.json`);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  let renamed = false;
  try {
    await rename(tempPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export function normalizeAbsolutePath(inputPath: string): string {
  return path.resolve(inputPath);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
}

export async function isExecutableOnPath(command: string): Promise<boolean> {
  const pathValue = process.env.PATH ?? "";
  for (const segment of pathValue.split(path.delimiter)) {
    if (!segment) {
      continue;
    }
    const candidate = path.join(segment, command);
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

export async function fileFingerprint(filePath: string): Promise<string> {
  try {
    const details = await stat(filePath);
    return `${details.mtimeMs}:${details.size}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}
