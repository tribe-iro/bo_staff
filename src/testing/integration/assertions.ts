import path from "node:path";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import type { BoStaffEvent, ExecutionRequest, ExecutionResponse, ResolvedExecutionProfile } from "../../types.ts";
import { asRecord } from "../../utils.ts";
import type { IntegrationContext } from "./fixtures.ts";

export async function executeRequest(input: {
  context: IntegrationContext;
  name: string;
  request: ExecutionRequest;
  expectedHttp: number;
  expectedStatuses: ExecutionResponse["execution"]["status"][];
}) {
  const requestPath = path.join(input.context.runRoot, `${input.name}.request.json`);
  const responsePath = path.join(input.context.runRoot, `${input.name}.json`);
  await writeJson(requestPath, input.request);
  showRequest(input.context, input.name, input.request);

  const response = await fetch(`${input.context.baseUrl}/executions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input.request)
  });
  const json = await response.json() as ExecutionResponse;
  await writeJson(responsePath, json);
  if (response.status !== input.expectedHttp) {
    throw new Error(`HTTP status for ${input.name}: expected '${input.expectedHttp}', got '${response.status}'`);
  }
  if (!input.expectedStatuses.includes(json.execution.status)) {
    throw new Error(`execution.status for ${input.name}: expected one of '${input.expectedStatuses.join("|")}', got '${json.execution.status}'`);
  }
  console.log(`[it] ${input.name}: http=${response.status} execution.status=${json.execution.status}`);
  showResponse(input.context, input.name, input.request, json);
  return { json, requestPath, responsePath };
}

export async function executeStream(input: {
  context: IntegrationContext;
  name: string;
  request: ExecutionRequest;
  expectedHttp: number;
  expectedTerminalEvent: BoStaffEvent["event"];
  expectedEvents?: BoStaffEvent["event"][];
}) {
  return executeRawStream({
    context: input.context,
    name: input.name,
    body: JSON.stringify(input.request),
    expectedHttp: input.expectedHttp,
    expectedTerminalEvent: input.expectedTerminalEvent,
    expectedEvents: input.expectedEvents,
    contentType: "application/json"
  });
}

export async function executeRawStream(input: {
  context: IntegrationContext;
  name: string;
  body: string;
  expectedHttp: number;
  expectedTerminalEvent: BoStaffEvent["event"];
  expectedEvents?: BoStaffEvent["event"][];
  contentType?: string;
}) {
  const requestPath = path.join(input.context.runRoot, `${input.name}.request.raw`);
  await writeFile(requestPath, `${input.body}\n`, "utf8");
  const response = await fetch(`${input.context.baseUrl}/executions/stream`, {
    method: "POST",
    headers: input.contentType ? { "content-type": input.contentType } : undefined,
    body: input.body
  });
  if (response.status !== input.expectedHttp) {
    throw new Error(`HTTP status for ${input.name}: expected '${input.expectedHttp}', got '${response.status}'`);
  }

  const raw = await response.text();
  await writeFile(path.join(input.context.runRoot, `${input.name}.stream.ndjson`), raw, "utf8");
  const events = raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BoStaffEvent);
  if (events.length === 0) {
    throw new Error(`${input.name}: expected at least one stream event`);
  }
  const terminal = events.at(-1);
  if (!terminal) {
    throw new Error(`${input.name}: missing terminal event`);
  }
  if (terminal.event !== input.expectedTerminalEvent) {
    throw new Error(`${input.name}: expected terminal event '${input.expectedTerminalEvent}', got '${terminal.event}'`);
  }
  if (input.expectedEvents) {
    const actual = events.map((event) => event.event);
    if (!containsOrderedSubsequence(actual, input.expectedEvents)) {
      throw new Error(`${input.name}: expected ordered event subsequence ${JSON.stringify(input.expectedEvents)}, got ${JSON.stringify(actual)}`);
    }
  }
  console.log(`[it] ${input.name}: stream terminal=${terminal.event}`);
  return { events };
}

function containsOrderedSubsequence(actual: string[], expected: string[]): boolean {
  let cursor = 0;
  for (const event of actual) {
    if (event === expected[cursor]) {
      cursor += 1;
      if (cursor === expected.length) {
        return true;
      }
    }
  }
  return expected.length === 0;
}

export async function fetchJson<T extends Record<string, unknown>>(input: {
  context: IntegrationContext;
  method: "GET" | "DELETE";
  path: string;
  expectedHttp: number;
  name: string;
}): Promise<T> {
  const response = await fetch(`${input.context.baseUrl}${input.path}`, {
    method: input.method
  });
  const json = await response.json() as T;
  if (response.status !== input.expectedHttp) {
    throw new Error(`HTTP status for ${input.name}: expected '${input.expectedHttp}', got '${response.status}'`);
  }
  console.log(`[it] ${input.name}: http=${response.status}`);
  if (input.context.showFullJson) {
    console.log(JSON.stringify(json, null, 2));
  }
  return json;
}

export function getPayloadContent(response: ExecutionResponse): string | undefined {
  const payload = asRecord(response.result.payload);
  return typeof payload?.content === "string" ? payload.content : undefined;
}

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

export interface ExpectedExecutionProfile {
  selection_mode?: ResolvedExecutionProfile["selection_mode"];
  resolved_backend_model?: string;
  resolved_backend_reasoning_control?: string | null;
  resolution_source?: ResolvedExecutionProfile["resolution_source"];
}

export function assertExecutionProfile(
  profile: ResolvedExecutionProfile,
  expected: ExpectedExecutionProfile,
  label: string
): void {
  if (expected.selection_mode !== undefined) {
    assertEq(profile.selection_mode, expected.selection_mode, `${label} selection_mode`);
  }
  if (expected.resolved_backend_model !== undefined) {
    assertEq(profile.resolved_backend_model, expected.resolved_backend_model, `${label} resolved_backend_model`);
  }
  if (expected.resolved_backend_reasoning_control !== undefined) {
    const expectedValue = expected.resolved_backend_reasoning_control === null
      ? undefined
      : expected.resolved_backend_reasoning_control;
    assertEq(
      profile.resolved_backend_reasoning_control,
      expectedValue,
      `${label} resolved_backend_reasoning_control`
    );
  }
  if (expected.resolution_source !== undefined) {
    assertEq(profile.resolution_source, expected.resolution_source, `${label} resolution_source`);
  }
}

export function assertNoErrors(response: ExecutionResponse, label: string): void {
  if (response.errors.length > 0) {
    throw new Error(`${label}: expected no errors, got ${JSON.stringify(response.errors)}`);
  }
}

export function assertCapabilityDegraded(response: ExecutionResponse, capability: keyof ExecutionResponse["capabilities"], label: string): void {
  if (response.capabilities[capability].status !== "degraded") {
    throw new Error(`${label}: expected capability '${capability}' to be degraded`);
  }
}

export function assertCapabilityNotDegraded(response: ExecutionResponse, capability: keyof ExecutionResponse["capabilities"], label: string): void {
  if (response.capabilities[capability].status === "degraded") {
    throw new Error(`${label}: expected capability '${capability}' not to be degraded`);
  }
}

export function assertArtifactKinds(response: ExecutionResponse, expectedKinds: string[], label: string): void {
  const actualKinds = response.artifacts.map((artifact) => artifact.kind).sort();
  const expectedSorted = expectedKinds.slice().sort();
  if (JSON.stringify(actualKinds) !== JSON.stringify(expectedSorted)) {
    throw new Error(`${label}: expected artifact kinds ${JSON.stringify(expectedSorted)}, got ${JSON.stringify(actualKinds)}`);
  }
}

export function getPayloadRecord(response: ExecutionResponse): Record<string, unknown> {
  const payload = asRecord(response.result.payload);
  if (!payload) {
    throw new Error("expected payload to be an object");
  }
  return payload;
}

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

export async function assertDirectoryContains(directoryPath: string, expectedEntries: string[]): Promise<void> {
  const entries = await readdir(directoryPath);
  for (const expected of expectedEntries) {
    if (!entries.includes(expected)) {
      throw new Error(`directory ${directoryPath} does not contain expected entry '${expected}'; actual=${JSON.stringify(entries)}`);
    }
  }
}

export async function assertTextAbsentFromGatewaySources(rootDir: string, text: string): Promise<void> {
  for (const relativePath of ["src", "test", "config", "scripts", "README.md"]) {
    const targetPath = path.join(rootDir, relativePath);
    if (await pathExists(targetPath)) {
      await assertTextAbsentRecursive(targetPath, text);
    }
  }
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function showRequest(context: IntegrationContext, label: string, request: ExecutionRequest): void {
  console.log(`[it] ${label} request`);
  console.log(`  backend: ${request.backend}`);
  console.log(`  session.mode: ${request.session?.mode ?? "new"}`);
  if (request.session?.handle) {
    console.log(`  session.handle: ${request.session.handle}`);
  }
  console.log(`  policy.isolation: ${request.policy?.isolation ?? "default"}`);
  console.log(`  policy.filesystem: ${request.policy?.filesystem ?? "default"}`);
  console.log(`  execution_profile.selection_mode: ${request.execution_profile?.selection_mode ?? "managed"}`);
  console.log(`  cwd: ${request.workspace?.source_root ?? "<ephemeral>"}`);
  console.log(`  prompt: ${request.task.prompt}`);
  if (context.showFullJson) {
    console.log(JSON.stringify(request, null, 2));
  }
}

const MAX_LOGGED_PAYLOAD_CHARS = 320;

function showResponse(
  context: IntegrationContext,
  label: string,
  request: ExecutionRequest,
  response: ExecutionResponse
): void {
  console.log(`[it] ${label} response`);
  console.log(`  execution.status: ${response.execution.status}`);
  console.log(`  session.handle: ${response.session.handle}`);
  console.log(`  session.continuity_kind: ${response.session.continuity_kind}`);
  console.log(`  workspace.topology: ${response.workspace.topology}`);
  console.log(`  workspace.writeback_status: ${response.workspace.writeback_status}`);
  console.log(`  workspace.materialization_status: ${response.workspace.materialization_status}`);
  console.log(`  resolved_backend_model: ${response.execution_profile.resolved_backend_model}`);
  if (response.execution_profile.resolved_backend_reasoning_control) {
    console.log(`  resolved_backend_reasoning_control: ${response.execution_profile.resolved_backend_reasoning_control}`);
  }
  const content = getPayloadContent(response);
  if ((request.output?.format ?? "message") === "message") {
    if (content) {
      console.log(`  payload.content: ${content}`);
    } else {
      console.log(`  payload: ${formatCompactPayload(response.result.payload)}`);
    }
  } else {
    console.log(`  payload: ${formatCompactPayload(response.result.payload)}`);
  }
  if (response.errors.length > 0) {
    console.log(`  errors: ${JSON.stringify(response.errors)}`);
  }
  if (context.showFullJson) {
    console.log(JSON.stringify(response, null, 2));
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
