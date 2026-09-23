import { randomBytes } from "node:crypto";
import { ENGINE_IDS, type EngineId } from "./model.ts";

export function mint(prefix: "run" | "itm"): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

const NATIVE_ID = /^[A-Za-z0-9._-]{1,200}$/;

export function encodeSession(engine: EngineId, native: string): string {
  return `ses_${Buffer.from(`${engine}:${native}`, "utf8").toString("base64url")}`;
}

export function decodeSession(id: string): { engine: EngineId; native: string } | null {
  if (!id.startsWith("ses_")) return null;
  const decoded = Buffer.from(id.slice(4), "base64url").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  const engine = decoded.slice(0, colon) as EngineId;
  const native = decoded.slice(colon + 1);
  if (!ENGINE_IDS.includes(engine) || !NATIVE_ID.test(native)) return null;
  // Round-trip guard: rejects non-canonical base64url spellings of the same bytes.
  return encodeSession(engine, native) === id ? { engine, native } : null;
}
