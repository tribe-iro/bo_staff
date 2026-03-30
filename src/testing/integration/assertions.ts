import path from "node:path";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import type { BomcpEnvelope, BomcpMessageKind } from "../../bomcp/types.ts";
import type { ExecutionRequest } from "../../types.ts";
import { asRecord } from "../../utils.ts";
import { extractAgentContent, extractAgentOutput } from "../../bomcp/output.ts";
import type { IntegrationContext } from "./fixtures.ts";

// ---------------------------------------------------------------------------
// Terminal-kind detection
// ---------------------------------------------------------------------------

const TERMINAL_KINDS: ReadonlySet<BomcpMessageKind> = new Set([
  "execution.completed",
  "execution.failed",
  "execution.cancelled",
]);

function isTerminalKind(kind: BomcpMessageKind): boolean {
  return TERMINAL_KINDS.has(kind);
}

// ---------------------------------------------------------------------------
// Request / response execution (non-streaming, still uses raw fetch)
// ---------------------------------------------------------------------------

export async function executeRequest(input: {
  context: IntegrationContext;
  name: string;
  request: ExecutionRequest;
  expectedHttp: number;
  expectedTerminalKind?: BomcpMessageKind;
}) {
  const requestPath = path.join(input.context.runRoot, `${input.name}.request.json`);
  const responsePath = path.join(input.context.runRoot, `${input.name}.stream.ndjson`);
  await writeJson(requestPath, input.request);
  showRequest(input.context, input.name, input.request);

  const response = await fetch(`${input.context.baseUrl}/executions/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input.request),
  });
  const raw = await response.text();
  await writeFile(responsePath, raw, "utf8");
  const envelopes = raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BomcpEnvelope);

  if (response.status !== input.expectedHttp) {
    throw new Error(
      `HTTP status for ${input.name}: expected '${input.expectedHttp}', got '${response.status}'`,
    );
  }

  const terminal = findLastWhere(envelopes, (env) => isTerminalKind(env.kind));
  if (input.expectedTerminalKind && terminal) {
    if (terminal.kind !== input.expectedTerminalKind) {
      throw new Error(
        `terminal kind for ${input.name}: expected '${input.expectedTerminalKind}', got '${terminal.kind}'`,
      );
    }
  } else if (input.expectedTerminalKind && !terminal) {
    throw new Error(
      `terminal kind for ${input.name}: expected '${input.expectedTerminalKind}', got 'none'`,
    );
  }

  console.log(
    `[it] ${input.name}: http=${response.status} terminal=${terminal?.kind ?? "none"} envelopes=${envelopes.length}`,
  );
  showEnvelopes(input.context, input.name, envelopes);
  return { envelopes, terminal };
}

// ---------------------------------------------------------------------------
// Streaming execution (NDJSON)
// ---------------------------------------------------------------------------

export async function executeStream(input: {
  context: IntegrationContext;
  name: string;
  request: ExecutionRequest;
  expectedHttp: number;
  expectedTerminalKind?: BomcpMessageKind;
  expectedKinds?: BomcpMessageKind[];
}) {
  return executeRawStream({
    context: input.context,
    name: input.name,
    body: JSON.stringify(input.request),
    expectedHttp: input.expectedHttp,
    expectedTerminalKind: input.expectedTerminalKind,
    expectedKinds: input.expectedKinds,
    contentType: "application/json",
  });
}

export async function executeRawStream(input: {
  context: IntegrationContext;
  name: string;
  body: string;
  expectedHttp: number;
  expectedTerminalKind?: BomcpMessageKind;
  expectedKinds?: BomcpMessageKind[];
  contentType?: string;
}) {
  const requestPath = path.join(input.context.runRoot, `${input.name}.request.raw`);
  await writeFile(requestPath, `${input.body}\n`, "utf8");
  const response = await fetch(`${input.context.baseUrl}/executions/stream`, {
    method: "POST",
    headers: input.contentType ? { "content-type": input.contentType } : undefined,
    body: input.body,
  });
  if (response.status !== input.expectedHttp) {
    throw new Error(
      `HTTP status for ${input.name}: expected '${input.expectedHttp}', got '${response.status}'`,
    );
  }

  const raw = await response.text();
  await writeFile(path.join(input.context.runRoot, `${input.name}.stream.ndjson`), raw, "utf8");
  const envelopes = raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BomcpEnvelope);
  if (envelopes.length === 0) {
    throw new Error(`${input.name}: expected at least one stream envelope`);
  }
  const terminal = findLastWhere(envelopes, (env) => isTerminalKind(env.kind));
  if (input.expectedTerminalKind && !terminal) {
    throw new Error(`${input.name}: missing terminal envelope`);
  }
  if (input.expectedTerminalKind && terminal && terminal.kind !== input.expectedTerminalKind) {
    throw new Error(
      `${input.name}: expected terminal kind '${input.expectedTerminalKind}', got '${terminal.kind}'`,
    );
  }
  if (input.expectedKinds) {
    const actual = envelopes.map((env) => env.kind);
    if (!containsOrderedSubsequence(actual, input.expectedKinds)) {
      throw new Error(
        `${input.name}: expected ordered kind subsequence ${JSON.stringify(input.expectedKinds)}, got ${JSON.stringify(actual)}`,
      );
    }
  }
  console.log(`[it] ${input.name}: stream terminal=${terminal?.kind ?? "none"}`);
  return { envelopes };
}

function containsOrderedSubsequence(actual: string[], expected: string[]): boolean {
  let cursor = 0;
  for (const item of actual) {
    if (item === expected[cursor]) {
      cursor += 1;
      if (cursor === expected.length) {
        return true;
      }
    }
  }
  return expected.length === 0;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

export async function fetchJson<T extends Record<string, unknown>>(input: {
  context: IntegrationContext;
  method: "GET" | "DELETE";
  path: string;
  expectedHttp: number;
  name: string;
}): Promise<T> {
  const response = await fetch(`${input.context.baseUrl}${input.path}`, {
    method: input.method,
  });
  const json = (await response.json()) as T;
  if (response.status !== input.expectedHttp) {
    throw new Error(
      `HTTP status for ${input.name}: expected '${input.expectedHttp}', got '${response.status}'`,
    );
  }
  console.log(`[it] ${input.name}: http=${response.status}`);
  if (input.context.showFullJson) {
    console.log(JSON.stringify(json, null, 2));
  }
  return json;
}

// ---------------------------------------------------------------------------
// Payload helpers
// ---------------------------------------------------------------------------

export function getPayloadContent(envelope: BomcpEnvelope): string | undefined {
  return extractAgentContent(envelope);
}

export function getPayloadRecord(envelope: BomcpEnvelope): Record<string, unknown> {
  const payload = asRecord(envelope.payload);
  if (!payload) {
    throw new Error("expected envelope payload to be an object");
  }
  return payload;
}

/**
 * Extract the agent's structured output from a terminal envelope.
 * The agent output lives inside payload.output as a JSON string in the compact format:
 * { summary: "...", payload: { content: "...", ...custom fields }, pending_items: [], artifacts: [] }
 * This function returns the inner payload object (the structured output the caller cares about).
 */
export function getAgentOutput(envelope: BomcpEnvelope): Record<string, unknown> {
  const result = extractAgentOutput(envelope);
  if (result) return result;
  const payload = asRecord(envelope.payload);
  if (!payload) throw new Error("expected envelope payload to be an object");
  return payload;
}

// ---------------------------------------------------------------------------
// Terminal envelope extractors
// ---------------------------------------------------------------------------

export function findTerminalEnvelope(envelopes: BomcpEnvelope[]): BomcpEnvelope | undefined {
  return findLastWhere(envelopes, (env) => isTerminalKind(env.kind));
}

function findLastWhere<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) {
      return items[i];
    }
  }
  return undefined;
}

export function requireTerminalEnvelope(envelopes: BomcpEnvelope[], label: string): BomcpEnvelope {
  const terminal = findTerminalEnvelope(envelopes);
  if (!terminal) {
    throw new Error(`${label}: no terminal envelope found`);
  }
  return terminal;
}

// ---------------------------------------------------------------------------
// Simple assertions
// ---------------------------------------------------------------------------

export function assertEq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected '${expected}', got '${actual}'`);
  }
}

export function assertContains(actual: string, expected: string, label: string): void {
  if (!actual.includes(expected)) {
    throw new Error(`${label}: expected '${actual}' to contain '${expected}'`);
  }
}

// ---------------------------------------------------------------------------
// Envelope payload assertions
// ---------------------------------------------------------------------------

export function assertPayloadField(
  envelope: BomcpEnvelope,
  field: string,
  expected: unknown,
  label: string,
): void {
  const payload = getPayloadRecord(envelope);
  assertEq(payload[field], expected, label);
}

export function assertNoPayloadErrors(envelope: BomcpEnvelope, label: string): void {
  const payload = asRecord(envelope.payload);
  const errors = payload?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`${label}: expected no errors, got ${JSON.stringify(errors)}`);
  }
}

// ---------------------------------------------------------------------------
// File / directory assertions
// ---------------------------------------------------------------------------

export async function assertFileContent(filePath: string, expected: string): Promise<void> {
  const actual = await readFile(filePath, "utf8");
  if (actual.replace(/\n$/, "") !== expected) {
    throw new Error(`file content for ${filePath}: expected '${expected}', got '${actual}'`);
  }
}

export async function assertPathAbsent(targetPath: string): Promise<void> {
  try {
    await stat(targetPath);
  } catch {
    return;
  }
  throw new Error(`expected path to be absent: ${targetPath}`);
}

export async function assertDirectoryContains(
  directoryPath: string,
  expectedEntries: string[],
): Promise<void> {
  const entries = await readdir(directoryPath);
  for (const expected of expectedEntries) {
    if (!entries.includes(expected)) {
      throw new Error(
        `directory ${directoryPath} does not contain expected entry '${expected}'; actual=${JSON.stringify(entries)}`,
      );
    }
  }
}

export async function assertTextAbsentFromGatewaySources(
  rootDir: string,
  text: string,
): Promise<void> {
  for (const relativePath of ["src", "test", "config", "scripts", "README.md"]) {
    const targetPath = path.join(rootDir, relativePath);
    if (await pathExists(targetPath)) {
      await assertTextAbsentRecursive(targetPath, text);
    }
  }
}

// ---------------------------------------------------------------------------
// JSON writer
// ---------------------------------------------------------------------------

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function showRequest(
  context: IntegrationContext,
  label: string,
  request: ExecutionRequest,
): void {
  console.log(`[it] ${label} request`);
  console.log(`  backend: ${request.backend}`);
  if (request.continuation) {
    console.log(`  continuation: ${request.continuation.backend}:${request.continuation.token}`);
  }
  console.log(`  execution_profile.model: ${request.execution_profile.model}`);
  console.log(`  cwd: ${request.workspace?.source_root ?? "<ephemeral>"}`);
  console.log(`  prompt: ${request.task.prompt}`);
  if (context.showFullJson) {
    console.log(JSON.stringify(request, null, 2));
  }
}

const MAX_LOGGED_PAYLOAD_CHARS = 320;

function showEnvelopes(
  context: IntegrationContext,
  label: string,
  envelopes: BomcpEnvelope[],
): void {
  if (!context.showFullJson) return;
  console.log(`[it] ${label} envelopes (${envelopes.length})`);
  for (const env of envelopes) {
    const payloadStr = formatCompactPayload(env.payload);
    console.log(`  [${env.sequence}] ${env.kind}: ${payloadStr}`);
  }
}

function formatCompactPayload(payload: unknown): string {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) {
    return String(payload);
  }
  return serialized.length > MAX_LOGGED_PAYLOAD_CHARS
    ? `${serialized.slice(0, MAX_LOGGED_PAYLOAD_CHARS)}...`
    : serialized;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function assertTextAbsentRecursive(targetPath: string, text: string): Promise<void> {
  const targetStat = await stat(targetPath);
  if (targetStat.isDirectory()) {
    const entries = await readdir(targetPath);
    for (const entry of entries) {
      await assertTextAbsentRecursive(path.join(targetPath, entry), text);
    }
    return;
  }
  const content = await readFile(targetPath, "utf8").catch(() => "");
  if (content.includes(text)) {
    throw new Error(`expected text '${text}' to be absent from ${targetPath}`);
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}
