import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { TextDecoder } from "node:util";
import type { IntegrationContext } from "../fixtures.ts";
import { assertContains, assertEq, getPayloadRecord } from "../assertions.ts";
import { buildRequest, type IntegrationAgent } from "./common.ts";
import type { BomcpEnvelope } from "../../../bomcp/types.ts";

export async function runCancelMidflightScenario(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  prefix: string,
) {
  const request = buildRequest(
    backend,
    sourceRoot,
    "Using tools, first run `sleep 20` in the current workspace. Only after that finishes, set payload.content to 'cancel-too-late'.",
    {
      runtime: { timeout_ms: 60_000 },
    },
  );

  const { response, envelopes, requestPath } = await openStreamingExecution(
    context.baseUrl,
    request,
    path.join(context.runRoot, `${prefix}.request.json`),
  );
  const responsePath = path.join(context.runRoot, `${prefix}.stream.ndjson`);

  let executionId: string | undefined;
  const collected: string[] = [];
  try {
    await consumeNdjsonStream(response, async (envelope) => {
      collected.push(JSON.stringify(envelope));
      if (!executionId && envelope.kind === "execution.started") {
        executionId = typeof envelope.execution_id === "string"
          ? envelope.execution_id
          : undefined;
        if (!executionId) {
          throw new Error(`${prefix}: execution.started missing execution_id`);
        }
        const cancelResponse = await fetch(`${context.baseUrl}/executions/${encodeURIComponent(executionId)}/cancel`, {
          method: "POST",
        });
        if (cancelResponse.status !== 202) {
          throw new Error(`${prefix}: expected cancel endpoint to return 202, got ${cancelResponse.status}`);
        }
      }
    });
  } finally {
    await writeFile(responsePath, `${collected.join("\n")}${collected.length > 0 ? "\n" : ""}`, "utf8");
  }

  if (!executionId) {
    throw new Error(`${prefix}: stream never emitted execution.started`);
  }

  const terminal = findTerminalEnvelopeFromStrings(collected);
  if (!terminal) {
    throw new Error(`${prefix}: missing terminal envelope`);
  }
  if (terminal.kind !== "execution.cancelled") {
    throw new Error(`${prefix}: expected execution.cancelled terminal, got ${terminal.kind}`);
  }
  const payload = getPayloadRecord(terminal);
  assertContains(String(payload.reason ?? ""), "cancel", `${prefix} cancellation reason`);
  console.log(`[it] ${prefix}: cancel mid-flight emitted execution.cancelled`);
}

export async function runAdmissionSaturationScenario(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  prefix: string,
) {
  const port = await allocatePort();
  const dataDir = path.join(context.runRoot, `${prefix}-data`);
  await mkdir(dataDir, { recursive: true });
  const server = spawn("node", ["src/server.ts"], {
    cwd: context.rootDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      BO_STAFF_DATA_DIR: dataDir,
      BO_STAFF_MAX_CONCURRENT_EXECUTIONS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverLogPath = path.join(context.runRoot, `${prefix}.server.log`);
  const serverChunks: Buffer[] = [];
  server.stdout?.on("data", (chunk) => serverChunks.push(Buffer.from(chunk)));
  server.stderr?.on("data", (chunk) => serverChunks.push(Buffer.from(chunk)));

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(baseUrl);

    const longRequest = buildRequest(
      backend,
      sourceRoot,
      "Using tools, first run `sleep 20` in the current workspace. Only after that finishes, set payload.content to 'slot-held'.",
      { runtime: { timeout_ms: 60_000 } },
    );
    const first = await openStreamingExecution(
      baseUrl,
      longRequest,
      path.join(context.runRoot, `${prefix}.primary.request.json`),
    );
    const firstCollected: string[] = [];
    let firstExecutionId: string | undefined;

    const firstWatcher = consumeNdjsonStream(first.response, async (envelope) => {
      firstCollected.push(JSON.stringify(envelope));
      if (!firstExecutionId && envelope.kind === "execution.started") {
        firstExecutionId = typeof envelope.execution_id === "string" ? envelope.execution_id : undefined;
      }
    });

    await waitForCondition(() => firstExecutionId !== undefined, 10_000, `${prefix}: primary execution did not start`);

    const secondRequest = buildRequest(
      backend,
      sourceRoot,
      "Set payload.content to 'should-not-run'.",
    );
    const secondResponse = await fetch(`${baseUrl}/executions/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(secondRequest),
    });
    const secondRaw = await secondResponse.text();
    await writeFile(path.join(context.runRoot, `${prefix}.busy.stream.ndjson`), secondRaw, "utf8");
    const secondEnvelopes = secondRaw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BomcpEnvelope);
    if (secondResponse.status !== 200) {
      throw new Error(`${prefix}: expected secondary request HTTP 200, got ${secondResponse.status}`);
    }
    const busyError = secondEnvelopes.find((env) => env.kind === "system.error");
    if (!busyError) {
      throw new Error(`${prefix}: expected system.error for saturated gateway`);
    }
    assertEq(getPayloadRecord(busyError).code, "gateway_busy", `${prefix} gateway_busy code`);

    if (!firstExecutionId) {
      throw new Error(`${prefix}: missing primary execution id for cleanup`);
    }
    const cancelResponse = await fetch(`${baseUrl}/executions/${encodeURIComponent(firstExecutionId)}/cancel`, {
      method: "POST",
    });
    if (cancelResponse.status !== 202) {
      throw new Error(`${prefix}: expected primary cancel HTTP 202, got ${cancelResponse.status}`);
    }
    await firstWatcher;
    await writeFile(
      path.join(context.runRoot, `${prefix}.primary.stream.ndjson`),
      `${firstCollected.join("\n")}${firstCollected.length > 0 ? "\n" : ""}`,
      "utf8",
    );
    console.log(`[it] ${prefix}: admission saturation rejected the second execution with gateway_busy`);
  } finally {
    await writeFile(serverLogPath, Buffer.concat(serverChunks), "utf8").catch(() => undefined);
    server.kill("SIGTERM");
    await waitForExit(server);
  }
}

async function openStreamingExecution(
  baseUrl: string,
  request: Record<string, unknown>,
  requestPath: string,
): Promise<{ response: Response }> {
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  const response = await fetch(`${baseUrl}/executions/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (response.status !== 200 || !response.body) {
    throw new Error(`stream request failed with HTTP ${response.status}`);
  }
  return { response };
}

async function consumeNdjsonStream(
  response: Response,
  onEnvelope: (envelope: BomcpEnvelope) => Promise<void> | void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("response body is not readable");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        await onEnvelope(JSON.parse(line) as BomcpEnvelope);
      }
      newlineIndex = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail) {
    await onEnvelope(JSON.parse(tail) as BomcpEnvelope);
  }
}

function findTerminalEnvelopeFromStrings(lines: string[]): BomcpEnvelope | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const envelope = JSON.parse(lines[i]) as BomcpEnvelope;
    if (envelope.kind === "execution.completed" || envelope.kind === "execution.failed" || envelope.kind === "execution.cancelled") {
      return envelope;
    }
  }
  return undefined;
}

async function waitForServer(baseUrl: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }
    await sleep(250);
  }
  throw new Error(`server did not become healthy on ${baseUrl}`);
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) {
      throw new Error(message);
    }
    await sleep(100);
  }
}

async function waitForExit(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    process.once("exit", () => resolve());
    setTimeout(() => resolve(), 5_000);
  });
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
