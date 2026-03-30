import { pathToFileURL } from "node:url";
import path from "node:path";
import { BoClient, BoStaffClientHttpError } from "./client.ts";
import type { BomcpEnvelope, BomcpMessageKind } from "./bomcp/types.ts";
import type { SyncRunResult } from "./api/sync-response.ts";

const TERMINAL_KINDS: ReadonlySet<BomcpMessageKind> = new Set([
  "execution.completed", "execution.failed", "execution.cancelled",
]);

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const isTTY = process.stdout.isTTY ?? false;

const ansi = {
  reset: isTTY ? "\x1b[0m" : "",
  dim: isTTY ? "\x1b[2m" : "",
  bold: isTTY ? "\x1b[1m" : "",
  green: isTTY ? "\x1b[32m" : "",
  yellow: isTTY ? "\x1b[33m" : "",
  red: isTTY ? "\x1b[31m" : "",
  cyan: isTTY ? "\x1b[36m" : "",
  magenta: isTTY ? "\x1b[35m" : "",
};

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  prompt: string;
  backend?: string;
  model?: string;
  workspace: string;
  files: string[];
  timeout?: number;
  reasoning?: string;
  stream: boolean;
  json: boolean;
  verbose: boolean;
  url: string;
}

function detectBackendFromArgv(): string | undefined {
  const script = process.argv[1] ?? "";
  const base = path.basename(script).replace(/\.[cm]?[jt]s$/, "");
  if (base === "bo.claude" || base === "bo-claude") return "claude";
  if (base === "bo.codex" || base === "bo-codex") return "codex";
  return undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const detectedBackend = detectBackendFromArgv();

  const result: Partial<CliArgs> & { prompt?: string; files: string[] } = {
    backend: detectedBackend,
    workspace: process.cwd(),
    files: [],
    stream: detectedBackend !== undefined, // stream by default for bo.claude / bo.codex
    json: false,
    verbose: false,
    url: process.env.BO_STAFF_URL ?? "http://127.0.0.1:3000",
  };

  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") { printUsage(); process.exit(0); }
    else if (arg === "--backend" || arg === "-b") result.backend = args[++i];
    else if (arg === "--model" || arg === "-m") result.model = args[++i];
    else if (arg === "--workspace" || arg === "-w") result.workspace = args[++i];
    else if (arg === "--timeout" || arg === "-t") result.timeout = Number(args[++i]);
    else if (arg === "--reasoning") result.reasoning = args[++i];
    else if (arg === "-i") {
      // Collect all following non-flag args as file references
      while (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        result.files.push(args[++i]);
      }
    }
    else if (arg === "--stream") result.stream = true;
    else if (arg === "--sync") result.stream = false;
    else if (arg === "--json") result.json = true;
    else if (arg === "--verbose") result.verbose = true;
    else if (arg === "--url") result.url = args[++i];
    else if (!arg.startsWith("-")) positional.push(arg);
    else { process.stderr.write(`Unknown flag: ${arg}\n`); process.exit(1); }
  }

  // Skip "run" subcommand if present
  if (positional[0] === "run") positional.shift();

  if (positional.length === 0) {
    const name = detectedBackend ? `bo.${detectedBackend}` : "bo";
    process.stderr.write(`Usage: ${name} <prompt> [flags]\n`);
    process.exit(1);
  }

  return {
    ...result,
    prompt: buildPrompt(positional.join(" "), result.files),
    workspace: result.workspace ?? process.cwd(),
    stream: result.stream ?? false,
    json: result.json ?? false,
    verbose: result.verbose ?? false,
    url: result.url ?? "http://127.0.0.1:3000",
  } as CliArgs;
}

function buildPrompt(prompt: string, files: string[]): string {
  if (files.length === 0) return prompt;
  const fileList = files.map((f) => `- ${f}`).join("\n");
  return `${prompt}\n\nFiles:\n${fileList}`;
}

function printUsage(): void {
  const name = detectBackendFromArgv();
  const cmd = name ? `bo.${name}` : "bo";
  process.stdout.write(`
bo_staff CLI

Usage:
  ${cmd} <prompt> [flags]
  ${cmd} run <prompt> [flags]

Flags:
  -i <files...>              Workspace files for the agent to read.
  -b, --backend <name>       Agent backend (claude, codex). ${name ? `Default: ${name}.` : "Auto-detected if omitted."}
  -m, --model <id>           Model ID. Defaults per backend.
  -w, --workspace <path>     Workspace directory. Defaults to cwd.
  -t, --timeout <seconds>    Execution timeout. Default: 600.
  --reasoning <tier>         Reasoning tier (none,light,standard,deep).
  --stream                   Stream envelopes with live output. ${name ? "Default." : ""}
  --sync                     Wait for completion, print result.
  --json                     Output as JSON / raw NDJSON.
  --verbose                  Show all envelope details.
  --url <gateway-url>        Gateway URL. Default: http://127.0.0.1:3000.
  -h, --help                 Show this help.

Examples:
  ${cmd} "fix the failing tests"
  ${cmd} "fix the bug" -i src/broken.ts test/broken.test.ts
  ${cmd} "list exported functions" --model ${name === "codex" ? "gpt-5.4" : "claude-opus-4-6"}
  ${cmd} "refactor auth module" --verbose
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const client = new BoClient({ url: args.url });

  try {
    if (args.stream) {
      await runStreaming(client, args);
    } else {
      await runSync(client, args);
    }
  } catch (err) {
    if (err instanceof BoStaffClientHttpError) {
      process.stderr.write(`${ansi.red}Error (HTTP ${err.status}): ${err.message}${ansi.reset}\n`);
      process.exit(1);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Sync mode
// ---------------------------------------------------------------------------

async function runSync(client: BoClient, args: CliArgs): Promise<void> {
  const result = await client.run(args.prompt, {
    backend: args.backend,
    model: args.model,
    workspace: args.workspace,
    timeout: args.timeout,
    reasoning: args.reasoning,
    verbose: args.verbose,
  });

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    printSyncResult(result);
  }

  process.exit(result.status === "completed" ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Streaming mode — live pretty output
// ---------------------------------------------------------------------------

async function runStreaming(client: BoClient, args: CliArgs): Promise<void> {
  let exitCode = 1;
  let headerPrinted = false;
  let hasOutput = false;

  for await (const envelope of client.stream(args.prompt, {
    backend: args.backend,
    model: args.model,
    workspace: args.workspace,
    timeout: args.timeout,
    reasoning: args.reasoning,
  })) {
    if (args.json) {
      process.stdout.write(JSON.stringify(envelope) + "\n");
      if (TERMINAL_KINDS.has(envelope.kind)) exitCode = envelope.kind === "execution.completed" ? 0 : 1;
      continue;
    }

    // Print header on first envelope
    if (!headerPrinted) {
      headerPrinted = true;
      const backendLabel = args.backend ?? "auto";
      const modelLabel = args.model ?? "default";
      process.stderr.write(`${ansi.dim}${backendLabel} ${ansi.reset}${ansi.dim}${modelLabel}${ansi.reset}\n`);
    }

    renderEnvelope(envelope, args.verbose);

    if (TERMINAL_KINDS.has(envelope.kind)) {
      exitCode = envelope.kind === "execution.completed" ? 0 : 1;
      hasOutput = renderTerminal(envelope, hasOutput);
    }
  }

  if (!headerPrinted) {
    process.stderr.write(`${ansi.red}No envelopes received.${ansi.reset}\n`);
  }

  process.exit(exitCode);
}

function renderEnvelope(env: BomcpEnvelope, verbose: boolean): void {
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
      // Content chunks — extract text from the provider
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
      // silent
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

function extractChunkText(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;

  // Codex: items array with type=agent_message or type=reasoning
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

  // Claude: text delta
  if (typeof payload.text === "string" && payload.text) {
    return payload.text;
  }

  // Generic content field
  if (typeof payload.content === "string" && payload.content) {
    return payload.content;
  }

  return undefined;
}

function renderTerminal(env: BomcpEnvelope, hasOutput: boolean): boolean {
  const p = env.payload as Record<string, unknown> | undefined;

  switch (env.kind) {
    case "execution.completed": {
      // Extract final output if present
      const output = p?.output ?? p?.content;
      if (typeof output === "string" && output) {
        if (hasOutput) process.stdout.write("\n");
        process.stdout.write(output + "\n");
        hasOutput = true;
      }

      // Usage
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

      // Artifacts
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

// ---------------------------------------------------------------------------
// Sync output (unchanged)
// ---------------------------------------------------------------------------

function printSyncResult(result: SyncRunResult): void {
  process.stdout.write(`${ansi.bold}Status:${ansi.reset} ${result.status}\n`);

  if (result.artifacts.length > 0) {
    process.stdout.write(`\n${ansi.magenta}Artifacts:${ansi.reset}\n`);
    for (const a of result.artifacts) {
      process.stdout.write(`  ${a.kind}: ${a.path}\n`);
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

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

// Run when invoked as main module or imported from a bin entry point
const isMain = !process.argv[1] || import.meta.url === pathToFileURL(process.argv[1]).href;
const isBinEntry = process.argv[1]?.includes("/bin/bo");

if (isMain || isBinEntry) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
