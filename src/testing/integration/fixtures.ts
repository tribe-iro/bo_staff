import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { runCommand } from "../../adapters/process.ts";

export interface IntegrationOptions {
  host: string;
  port?: number;
  keep: boolean;
  pauseSec: number;
  showFullJson: boolean;
  showProviderDetails: boolean;
  showGatewayPrompt: boolean;
  agents: Array<"codex" | "claude">;
  tmpDir?: string;
  scenarioFilter?: Set<string>;
}

export interface IntegrationContext {
  rootDir: string;
  runRoot: string;
  dataDir: string;
  projectsDir: string;
  serverLog: string;
  baseUrl: string;
  host: string;
  port: number;
  keep: boolean;
  pauseSec: number;
  showFullJson: boolean;
  showProviderDetails: boolean;
  showGatewayPrompt: boolean;
  agents: Array<"codex" | "claude">;
  scenarioFilter?: Set<string>;
  scenarioStats: {
    planned: number;
    executed: number;
    skipped: number;
  };
  server?: ChildProcess;
}

export async function createIntegrationContext(rootDir: string, options: IntegrationOptions): Promise<IntegrationContext> {
  const port = options.port ?? await allocatePort();
  const runRoot = options.tmpDir ?? await mkdtemp(path.join(os.tmpdir(), "bo-staff-it."));
  const dataDir = path.join(runRoot, "bo-staff-data");
  const projectsDir = path.join(runRoot, "projects");
  const serverLog = path.join(runRoot, "server.log");
  await mkdir(projectsDir, { recursive: true });

  return {
    rootDir,
    runRoot,
    dataDir,
    projectsDir,
    serverLog,
    baseUrl: `http://${options.host}:${port}`,
    host: options.host,
    port,
    keep: options.keep,
    pauseSec: options.pauseSec,
    showFullJson: options.showFullJson,
    showProviderDetails: options.showProviderDetails,
    showGatewayPrompt: options.showGatewayPrompt,
    agents: options.agents,
    scenarioFilter: options.scenarioFilter,
    scenarioStats: {
      planned: 0,
      executed: 0,
      skipped: 0
    }
  };
}

export async function prepareProjects(context: IntegrationContext): Promise<void> {
  const projectNames = [
    "codex-read",
    "codex-write",
    "codex-isolated",
    "codex-discard",
    "codex-cleanup",
    "codex-session",
    "codex-task",
    "claude-read",
    "claude-write",
    "claude-isolated",
    "claude-discard",
    "claude-session",
    "claude-task",
    "non-git-isolated"
  ];
  for (const name of projectNames) {
    await mkdir(path.join(context.projectsDir, name), { recursive: true });
  }

  await writeFile(path.join(context.projectsDir, "codex-read", "workspace.txt"), "project-codex-read-visible-text\n", "utf8");
  await writeFile(path.join(context.projectsDir, "codex-read", "AGENTS.md"), "Instruction marker placeholder.\n", "utf8");
  await writeFile(path.join(context.projectsDir, "codex-write", "workspace.txt"), "project-codex-write-visible-text\n", "utf8");
  await writeFile(path.join(context.projectsDir, "codex-isolated", "tracked.txt"), "tracked-codex-before\n", "utf8");
  await writeFile(path.join(context.projectsDir, "codex-discard", "tracked.txt"), "tracked-codex-discard-before\n", "utf8");
  await writeFile(path.join(context.projectsDir, "codex-cleanup", "tracked.txt"), "tracked-codex-cleanup\n", "utf8");
  await writeFile(path.join(context.projectsDir, "codex-session", "workspace.txt"), "project-codex-session-visible-text\n", "utf8");
  await writeFile(path.join(context.projectsDir, "codex-task", "brief.txt"), "file-brief-codex\n", "utf8");

  await writeFile(path.join(context.projectsDir, "claude-read", "workspace.txt"), "project-claude-read-visible-text\n", "utf8");
  await writeFile(path.join(context.projectsDir, "claude-read", "CLAUDE.md"), "Instruction marker placeholder.\n", "utf8");
  await writeFile(path.join(context.projectsDir, "claude-write", "workspace.txt"), "project-claude-write-visible-text\n", "utf8");
  await writeFile(path.join(context.projectsDir, "claude-isolated", "tracked.txt"), "tracked-claude-before\n", "utf8");
  await writeFile(path.join(context.projectsDir, "claude-discard", "tracked.txt"), "tracked-claude-discard-before\n", "utf8");
  await writeFile(path.join(context.projectsDir, "claude-session", "workspace.txt"), "project-claude-session-visible-text\n", "utf8");
  await writeFile(path.join(context.projectsDir, "claude-task", "brief.txt"), "file-brief-claude\n", "utf8");
  await writeFile(path.join(context.projectsDir, "non-git-isolated", "workspace.txt"), "plain-dir\n", "utf8");

  await initGitRepo(path.join(context.projectsDir, "codex-isolated"));
  await initGitRepo(path.join(context.projectsDir, "codex-discard"));
  await initGitRepo(path.join(context.projectsDir, "codex-cleanup"));
  await initGitRepo(path.join(context.projectsDir, "claude-isolated"));
  await initGitRepo(path.join(context.projectsDir, "claude-discard"));
  await initGitRepo(path.join(context.projectsDir, "codex-session"));
  await initGitRepo(path.join(context.projectsDir, "claude-session"));
}

export async function startServer(context: IntegrationContext): Promise<void> {
  const server = spawn("node", ["src/server.ts"], {
    cwd: context.rootDir,
    env: {
      ...process.env,
      HOST: context.host,
      PORT: String(context.port),
      BO_STAFF_DATA_DIR: context.dataDir
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.server = server;
  const chunks: Buffer[] = [];
  server.stdout?.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  server.stderr?.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

  const started = Date.now();
  while (Date.now() - started < 10_000) {
    try {
      const response = await fetch(`${context.baseUrl}/health`);
      if (response.ok) {
        await writeFile(context.serverLog, Buffer.concat(chunks), "utf8");
        return;
      }
    } catch {
      // retry
    }
    await sleep(250);
  }
  throw new Error(`server did not become healthy on ${context.baseUrl}`);
}

export async function cleanupContext(context: IntegrationContext): Promise<void> {
  if (context.server?.pid) {
    context.server.kill("SIGTERM");
  }
  if (!context.keep) {
    await rm(context.runRoot, { recursive: true, force: true });
  }
}

export async function pauseStep(context: IntegrationContext): Promise<void> {
  if (context.pauseSec > 0) {
    await sleep(context.pauseSec * 1000);
  }
}

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to allocate port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function initGitRepo(workDir: string): Promise<void> {
  await runCommand({ command: "git", args: ["init"], cwd: workDir, timeoutMs: 10_000 });
  await runCommand({ command: "git", args: ["config", "user.email", "integration@example.com"], cwd: workDir, timeoutMs: 10_000 });
  await runCommand({ command: "git", args: ["config", "user.name", "Integration"], cwd: workDir, timeoutMs: 10_000 });
  await runCommand({ command: "git", args: ["add", "."], cwd: workDir, timeoutMs: 10_000 });
  await runCommand({ command: "git", args: ["commit", "-m", "init"], cwd: workDir, timeoutMs: 10_000 });
}
