#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";
import { BoStaffClient, BoStaffClientHttpError } from "./client.ts";
import type { ExecutionRequest, ExecutionResponse, BackendName } from "./types.ts";

function parseArgs(argv: string[]): { flags: Record<string, string>; prompt: string } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        index += 2;
      } else {
        flags[key] = "true";
        index += 1;
      }
      continue;
    }
    if (/^-[a-zA-Z]$/.test(arg)) {
      flags[arg.slice(1)] = "true";
      index += 1;
      continue;
    }
    positional.push(arg);
    index += 1;
  }
  return {
    flags,
    prompt: positional.join(" ")
  };
}

function buildRequest(flags: Record<string, string>, prompt: string): ExecutionRequest {
  const backend = parseBackend(flags.backend);
  const workingDirectory = flags.dir ? path.resolve(flags.dir) : process.cwd();
  const timeoutMs = flags["timeout-ms"] ? Number(flags["timeout-ms"]) : undefined;
  const filesystem = parseFilesystem(flags.sandbox);
  return {
    backend,
    execution_profile: {
      performance_tier: "balanced",
      reasoning_tier: "standard",
      selection_mode: flags.model ? "override" : "managed",
      override: flags.model
    },
    runtime: timeoutMs === undefined ? undefined : { timeout_ms: timeoutMs },
    task: {
      prompt
    },
    session: {
      mode: "ephemeral"
    },
    workspace: {
      source_root: workingDirectory,
      writeback: "apply"
    },
    policy: {
      filesystem
    }
  };
}

function printResponse(response: ExecutionResponse, printJson: boolean): never {
  if (printJson) {
    process.stdout.write(JSON.stringify(response, null, 2) + "\n");
    process.exit(response.execution.status === "completed" ? 0 : 1);
  }
  const payload = response.result.payload;
  const content = payload && typeof payload === "object" && !Array.isArray(payload) && typeof (payload as Record<string, unknown>).content === "string"
    ? (payload as Record<string, string>).content
    : undefined;
  process.stdout.write(content ?? JSON.stringify(payload, null, 2));
  process.stdout.write("\n");
  process.exit(response.execution.status === "completed" ? 0 : 1);
}

function formatClientHttpError(error: BoStaffClientHttpError): string {
  if (error.body && typeof error.body === "object") {
    const parsedMessage = (error.body as { error?: { message?: unknown } }).error?.message;
    if (typeof parsedMessage === "string" && parsedMessage.trim()) {
      return parsedMessage;
    }
  }
  return error.message;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { flags, prompt } = parseArgs(argv);
  if (flags.help === "true" || flags.h === "true" || !prompt.trim()) {
    process.stderr.write("Usage: node src/cli.ts [--backend codex|claude] [--sandbox read-only|workspace-write|danger-full-access] [--model <id>] [--dir <path>] [--timeout-ms <ms>] [--url <url>] [--json] \"prompt\"\n");
    process.exit(flags.help === "true" || flags.h === "true" ? 0 : 1);
  }

  const gatewayUrl = flags.url ?? "http://127.0.0.1:3000";
  const printJson = flags.json === "true";

  try {
    const request = buildRequest(flags, prompt);
    const client = new BoStaffClient({ baseUrl: gatewayUrl });
    printResponse(await client.execute(request), printJson);
  } catch (error) {
    if (error instanceof BoStaffClientHttpError) {
      process.stderr.write(`${formatClientHttpError(error)}\n`);
      process.exit(1);
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

function parseBackend(value: string | undefined): BackendName {
  if (!value) {
    return "codex";
  }
  if (value === "codex" || value === "claude") {
    return value;
  }
  throw new Error(`Unsupported backend '${value}'. Use codex or claude.`);
}

function parseFilesystem(value: string | undefined): "read_only" | "workspace_write" | "full_access" | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "read-only") {
    return "read_only";
  }
  if (value === "workspace-write") {
    return "workspace_write";
  }
  if (value === "danger-full-access") {
    return "full_access";
  }
  throw new Error(`Unsupported sandbox '${value}'. Use read-only, workspace-write, or danger-full-access.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
