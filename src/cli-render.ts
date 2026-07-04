import type { SyncRunResult } from "./api/sync-response.ts";
import type { BomcpEnvelope, BomcpMessageKind } from "./events/types.ts";

const isTTY = process.stdout.isTTY ?? false;

export const ansi = {
  reset: isTTY ? "\x1b[0m" : "",
  dim: isTTY ? "\x1b[2m" : "",
  bold: isTTY ? "\x1b[1m" : "",
  green: isTTY ? "\x1b[32m" : "",
  yellow: isTTY ? "\x1b[33m" : "",
  red: isTTY ? "\x1b[31m" : "",
  cyan: isTTY ? "\x1b[36m" : "",
  magenta: isTTY ? "\x1b[35m" : "",
};

export const TERMINAL_KINDS: ReadonlySet<BomcpMessageKind> = new Set([
  "execution.completed", "execution.failed", "execution.cancelled",
]);

export function renderEnvelope(env: BomcpEnvelope, verbose: boolean): void {
  const p = env.payload as Record<string, unknown> | undefined;

  switch (env.kind) {
    case "execution.started":
      process.stderr.write(`${ansi.dim}  exec ${p?.execution_id ?? ""}${ansi.reset}\n`);
      break;
    case "progress.update": {
      const parts: string[] = [];
      if (p?.phase) parts.push(String(p.phase));
      if (p?.percent !== undefined) parts.push(`${p.percent}%`);
      if (p?.detail) parts.push(String(p.detail));
      if (parts.length) {
        process.stderr.write(`${ansi.cyan}  [progress]${ansi.reset} ${parts.join(" — ")}\n`);
      }
      break;
    }
    case "progress.chunk": {
      const text = extractChunkText(p);
      if (text) {
        process.stdout.write(text);
      }
      break;
    }
    case "control.handoff": {
      const kind = p?.kind ?? "unknown";
      const reason = p?.reason_code ? ` (${p.reason_code})` : "";
      process.stderr.write(`${ansi.yellow}  [handoff]${ansi.reset} ${kind}${reason}\n`);
      break;
    }
    case "artifact.registered": {
      const artPath = p?.path ?? p?.artifact_id ?? "";
      process.stderr.write(`${ansi.magenta}  [artifact]${ansi.reset} ${p?.kind ?? ""} ${artPath}\n`);
      break;
    }
    case "system.error": {
      const code = p?.code ?? "";
      const msg = p?.message ?? "";
      process.stderr.write(`${ansi.red}  [error]${ansi.reset} ${code}: ${msg}\n`);
      break;
    }
    case "system.lease_expired":
      process.stderr.write(`${ansi.red}  [expired]${ansi.reset} lease timeout\n`);
      break;
    case "progress.heartbeat":
      break;
    default:
      if (verbose) {
        const payload = typeof env.payload === "object" ? JSON.stringify(env.payload) : String(env.payload);
        const truncated = payload.length > 200 ? payload.slice(0, 200) + "..." : payload;
        process.stderr.write(`${ansi.dim}  [${env.kind}] ${truncated}${ansi.reset}\n`);
      }
      break;
  }
}

export function renderTerminal(env: BomcpEnvelope, hasOutput: boolean): boolean {
  const p = env.payload as Record<string, unknown> | undefined;

  switch (env.kind) {
    case "execution.completed": {
      const output = p?.output ?? p?.content;
      if (typeof output === "string" && output) {
        if (hasOutput) process.stdout.write("\n");
        process.stdout.write(output + "\n");
        hasOutput = true;
      }
      const usage = p?.usage as Record<string, unknown> | undefined;
      if (usage) {
        const parts: string[] = [];
        if (usage.input_tokens) parts.push(`in:${usage.input_tokens}`);
        if (usage.output_tokens) parts.push(`out:${usage.output_tokens}`);
        if (usage.duration_ms) parts.push(`${usage.duration_ms}ms`);
        if (parts.length) {
          process.stderr.write(`${ansi.dim}  ${parts.join(" ")}${ansi.reset}\n`);
        }
      }
      const artifacts = p?.artifacts;
      if (Array.isArray(artifacts) && artifacts.length > 0) {
        for (const a of artifacts) {
          const rec = a as Record<string, unknown>;
          process.stderr.write(`${ansi.magenta}  [artifact]${ansi.reset} ${rec.kind ?? ""}: ${rec.path ?? ""}\n`);
        }
      }
      break;
    }
    case "execution.failed":
      process.stderr.write(`${ansi.red}  failed: ${p?.message ?? "unknown error"}${ansi.reset}\n`);
      break;
    case "execution.cancelled":
      process.stderr.write(`${ansi.yellow}  cancelled: ${p?.reason ?? ""}${ansi.reset}\n`);
      break;
  }

  return hasOutput;
}

export function printSyncResult(result: SyncRunResult): void {
  process.stdout.write(`${ansi.bold}Status:${ansi.reset} ${result.status}\n`);

  if (result.artifacts.length > 0) {
    process.stdout.write(`\n${ansi.magenta}Artifacts:${ansi.reset}\n`);
    for (const a of result.artifacts) {
      process.stdout.write(`  ${a.kind}: ${a.path}\n`);
    }
  }

  if (result.handoffs.length > 0) {
    process.stdout.write(`\n${ansi.yellow}Handoffs:${ansi.reset}\n`);
    for (const h of result.handoffs) {
      process.stdout.write(`  ${h.kind}\n`);
    }
  }

  if (result.output) {
    process.stdout.write(`\n${result.output}\n`);
  }

  if (result.continuation) {
    process.stderr.write(`${ansi.dim}continuation: ${result.continuation.backend}:${result.continuation.token}${ansi.reset}\n`);
  }

  if (result.error) {
    process.stderr.write(`\n${ansi.red}Error [${result.error.code}]: ${result.error.message}${ansi.reset}\n`);
  }

  if (result.usage) {
    const parts: string[] = [];
    if (result.usage.input_tokens) parts.push(`in:${result.usage.input_tokens}`);
    if (result.usage.output_tokens) parts.push(`out:${result.usage.output_tokens}`);
    if (result.usage.duration_ms) parts.push(`${result.usage.duration_ms}ms`);
    if (parts.length) process.stderr.write(`${ansi.dim}${parts.join(" ")}${ansi.reset}\n`);
  }
}

function extractChunkText(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  if (Array.isArray(payload.items)) {
    const texts: string[] = [];
    for (const item of payload.items) {
      if (typeof item === "object" && item !== null) {
        const rec = item as Record<string, unknown>;
        if (rec.type === "agent_message" && typeof rec.text === "string" && rec.text) {
          texts.push(rec.text);
        }
      }
    }
    if (texts.length) return texts.join("");
  }
  if (typeof payload.text === "string" && payload.text) {
    return payload.text;
  }
  if (typeof payload.content === "string" && payload.content) {
    return payload.content;
  }
  return undefined;
}
