import path from "node:path";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { pathToFileURL } from "node:url";
import { cleanupContext, createIntegrationContext, pauseStep, prepareProjects, startServer } from "./fixtures.ts";
import { runClaudeScenarios, runCodexScenarios } from "./scenarios.ts";

async function main() {
  const rootDir = path.resolve(path.join(import.meta.dirname, "..", "..", ".."));
  const agents = parseAgents(process.env.BO_STAFF_IT_AGENTS ?? "codex,claude");
  for (const agent of agents) {
    await ensureCommand(agent);
  }

  const context = await createIntegrationContext(rootDir, {
    host: process.env.BO_STAFF_IT_HOST ?? "127.0.0.1",
    port: process.env.BO_STAFF_IT_PORT ? Number(process.env.BO_STAFF_IT_PORT) : undefined,
    keep: (process.env.BO_STAFF_IT_KEEP ?? "1") === "1",
    pauseSec: Number(process.env.BO_STAFF_IT_PAUSE_SEC ?? "2"),
    showFullJson: (process.env.BO_STAFF_IT_SHOW_FULL_JSON ?? "0") === "1",
    showProviderDetails: (process.env.BO_STAFF_IT_SHOW_PROVIDER ?? "0") === "1",
    showGatewayPrompt: (process.env.BO_STAFF_IT_SHOW_GATEWAY_PROMPT ?? "0") === "1",
    agents,
    tmpDir: process.env.BO_STAFF_IT_TMPDIR,
    scenarioFilter: parseScenarioFilter(process.env.BO_STAFF_IT_SCENARIOS)
  });

  let failed = false;
  try {
    logSection("Preparing Projects");
    await prepareProjects(context);
    console.log(`[it] projects root: ${context.projectsDir}`);

    logSection("Starting Server");
    await startServer(context);
    console.log(`[it] server: ${context.baseUrl}`);
    console.log(`[it] data dir: ${context.dataDir}`);

    if (agents.includes("codex")) {
      await runCodexScenarios(context);
    }
    if (agents.includes("claude")) {
      await runClaudeScenarios(context);
    }

    logSection("Summary");
    console.log("[it] success");
    console.log(`[it] scenarios: planned=${context.scenarioStats.planned} executed=${context.scenarioStats.executed} skipped=${context.scenarioStats.skipped}`);
    console.log(`[it] artifacts kept at: ${context.runRoot}`);
  } catch (error) {
    failed = true;
    console.error("[it] failed");
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    console.error(`[it] artifacts kept at: ${context.runRoot}`);
    process.exitCode = 1;
  } finally {
    if (failed) {
      context.keep = true;
    }
    await pauseStep({ ...context, pauseSec: 0 });
    await cleanupContext(context);
  }
}

function parseScenarioFilter(raw: string | undefined): Set<string> | undefined {
  if (!raw || raw.trim() === "" || raw.trim() === "*") {
    return undefined;
  }
  const values = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return values.length > 0 ? new Set(values) : undefined;
}

function parseAgents(raw: string): Array<"codex" | "claude"> {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry): entry is "codex" | "claude" => entry === "codex" || entry === "claude");
}

async function ensureCommand(command: string): Promise<void> {
  const paths = (process.env.PATH ?? "").split(path.delimiter);
  for (const segment of paths) {
    if (!segment) {
      continue;
    }
    try {
      await access(path.join(segment, command), constants.X_OK);
      return;
    } catch {
      continue;
    }
  }
  throw new Error(`missing required command: ${command}`);
}

function logSection(title: string): void {
  console.log(`\n== ${title} ==`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
