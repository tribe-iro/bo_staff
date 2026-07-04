import { pathToFileURL } from "node:url";
import { BoClient, BoStaffClientHttpError } from "./client.ts";
import { parseArgs, type CliArgs } from "./cli-args.ts";
import { ansi, printSyncResult, renderEnvelope, renderTerminal, TERMINAL_KINDS } from "./cli-render.ts";

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
