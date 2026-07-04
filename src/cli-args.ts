import path from "node:path";

export interface CliArgs {
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

export function detectBackendFromArgv(argv = process.argv): string | undefined {
  const script = argv[1] ?? "";
  const base = path.basename(script).replace(/\.[cm]?[jt]s$/, "");
  if (base === "bo.claude" || base === "bo-claude") return "claude";
  if (base === "bo.codex" || base === "bo-codex") return "codex";
  return undefined;
}

export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const detectedBackend = detectBackendFromArgv(argv);

  const result: Partial<CliArgs> & { prompt?: string; files: string[] } = {
    backend: detectedBackend,
    workspace: process.cwd(),
    files: [],
    stream: detectedBackend !== undefined,
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

export function printUsage(): void {
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
  ${cmd} "list exported functions" --model ${name === "codex" ? "gpt-5.5" : "claude-opus-4-8"}
  ${cmd} "refactor auth module" --verbose
`);
}
