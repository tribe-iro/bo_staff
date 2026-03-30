import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { IntegrationContext } from "../fixtures.ts";
import {
  assertContains,
  assertEq,
  executeRequest,
  getPayloadContent,
  getPayloadRecord,
} from "../assertions.ts";
import { buildRequest, type IntegrationAgent } from "./common.ts";
import type { BomcpEnvelope } from "../../../bomcp/types.ts";

// ---------------------------------------------------------------------------
// Scenario: Agent calls bomcp.progress.update during execution
// ---------------------------------------------------------------------------

export async function runProgressUpdateScenario(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  prefix: string,
) {
  const result = await executeRequest({
    context,
    name: prefix,
    request: buildRequest(backend, sourceRoot,
      "Use the bomcp.progress.update tool to report phase 'analyzing' with percent 50. Then set payload.content to 'progress-ok'.",
      {
        lease: {
          allowed_tools: ["bomcp.progress.update"],
          timeout_seconds: 120,
        },
      },
    ),
    expectedHttp: 200,
    expectedTerminalKind: "execution.completed",
  });

  const toolCalls = getMcpToolCalls(result.envelopes, "bomcp.progress.update");
  const failedCall = toolCalls.find((call) => call.status === "failed");
  if (failedCall) {
    throw new Error(`${prefix}: bomcp.progress.update tool call failed: ${String(failedCall.error?.message ?? "unknown error")}`);
  }

  const progressEnvelopes = result.envelopes.filter((e: BomcpEnvelope) => e.kind === "progress.update");
  const matchingProgress = progressEnvelopes.filter((env) => {
    const payload = getPayloadRecord(env);
    return payload.phase === "analyzing" && payload.percent === 50;
  });
  if (matchingProgress.length === 0) {
    throw new Error(`${prefix}: expected a bomcp progress.update envelope with phase=analyzing and percent=50`);
  }
  console.log(`[it] ${prefix}: bomcp progress.update emitted correctly`);
}

// ---------------------------------------------------------------------------
// Scenario: Agent calls bomcp.artifact.register
// ---------------------------------------------------------------------------

export async function runArtifactRegisterScenario(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  prefix: string,
) {
  const result = await executeRequest({
    context,
    name: prefix,
    request: buildRequest(backend, sourceRoot,
      "First, create a file called 'artifact-test.md' with content 'hello from artifact test'. Then use the bomcp.artifact.register tool to register it with kind 'test' and path 'artifact-test.md'. Then set payload.content to 'artifact-ok'.",
      {
        lease: {
          allowed_tools: ["bomcp.artifact.register", "bomcp.progress.update"],
          timeout_seconds: 120,
        },
      },
    ),
    expectedHttp: 200,
    expectedTerminalKind: "execution.completed",
  });

  // Verify artifact.register request was emitted by agent
  const registerEnvelopes = result.envelopes.filter((e: BomcpEnvelope) => e.kind === "artifact.register");
  // Verify artifact.registered confirmation was emitted by runtime
  const registeredEnvelopes = result.envelopes.filter((e: BomcpEnvelope) => e.kind === "artifact.registered");

  if (registerEnvelopes.length === 0) {
    throw new Error(`${prefix}: expected at least one artifact.register envelope`);
  }
  assertEq(registeredEnvelopes.length, registerEnvelopes.length, `${prefix} artifact.registered count`);
  const registered = getPayloadRecord(registeredEnvelopes[0]);
  assertEq(registered.status, "registered", `${prefix} artifact.registered status`);
  console.log(`[it] ${prefix}: artifact registered: ${JSON.stringify(registered)}`);
}

// ---------------------------------------------------------------------------
// Scenario: Agent attempts to register an artifact outside the workspace scope
// ---------------------------------------------------------------------------

export async function runArtifactRegisterEscapeScenario(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  prefix: string,
) {
  const outsideName = `${prefix}-outside.md`;
  await writeFile(path.join(context.projectsDir, outsideName), "outside workspace\n", "utf8");

  const result = await executeRequest({
    context,
    name: prefix,
    request: buildRequest(backend, sourceRoot,
      `Use the bomcp.artifact.register tool to register path '../${outsideName}' with kind 'escape'. Then set payload.content to 'artifact-escape-ok'.`,
      {
        lease: {
          allowed_tools: ["bomcp.artifact.register", "bomcp.progress.update"],
          timeout_seconds: 120,
        },
      },
    ),
    expectedHttp: 200,
    expectedTerminalKind: "execution.completed",
  });

  const registerEnvelopes = result.envelopes.filter((e: BomcpEnvelope) => e.kind === "artifact.register");
  const rejectedEnvelopes = result.envelopes.filter((e: BomcpEnvelope) => e.kind === "artifact.registration_rejected");
  const acceptedEnvelopes = result.envelopes.filter((e: BomcpEnvelope) => e.kind === "artifact.registered");

  if (registerEnvelopes.length === 0) {
    throw new Error(`${prefix}: expected at least one artifact.register envelope`);
  }
  if (rejectedEnvelopes.length === 0) {
    throw new Error(`${prefix}: expected artifact.registration_rejected for outside path`);
  }
  if (acceptedEnvelopes.length > 0) {
    throw new Error(`${prefix}: outside artifact path must not be registered`);
  }

  const rejected = getPayloadRecord(rejectedEnvelopes[0]);
  assertEq(rejected.reason, "path_outside_artifact_root", `${prefix} artifact rejection reason`);
  console.log(`[it] ${prefix}: outside artifact registration rejected`);
}

// ---------------------------------------------------------------------------
// Scenario: Agent calls bomcp.artifact.require
// ---------------------------------------------------------------------------

export async function runArtifactRequireScenario(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  prefix: string,
) {
  const result = await executeRequest({
    context,
    name: prefix,
    request: buildRequest(backend, sourceRoot,
      "Use the bomcp.artifact.require tool with kind 'workspace' and path 'workspace.txt'. Then set payload.content to 'artifact-require-ok'.",
      {
        lease: {
          allowed_tools: ["bomcp.artifact.require", "bomcp.progress.update"],
          timeout_seconds: 120,
        },
      },
    ),
    expectedHttp: 200,
    expectedTerminalKind: "execution.completed",
  });

  const requireEnvelopes = result.envelopes.filter((e: BomcpEnvelope) => e.kind === "artifact.require");
  const availableEnvelopes = result.envelopes.filter((e: BomcpEnvelope) => e.kind === "artifact.available");

  if (requireEnvelopes.length === 0) {
    throw new Error(`${prefix}: expected at least one artifact.require envelope`);
  }
  if (availableEnvelopes.length === 0) {
    throw new Error(`${prefix}: expected at least one artifact.available envelope`);
  }

  const available = getPayloadRecord(availableEnvelopes[0]);
  assertEq(available.path, "workspace.txt", `${prefix} artifact.available path`);
  console.log(`[it] ${prefix}: artifact.require resolved for workspace.txt`);
}

// ---------------------------------------------------------------------------
// Scenario: Agent calls bomcp.control.handoff
// ---------------------------------------------------------------------------

export async function runHandoffScenario(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  prefix: string,
) {
  const result = await executeRequest({
    context,
    name: prefix,
    request: buildRequest(backend, sourceRoot,
      "Use the bomcp.control.handoff tool with kind 'continue_with_prompt', reason_code 'needs_review', and next.prompt_id 'review_patch'. Then set payload.content to 'handoff-ok'.",
      {
        lease: {
          allowed_tools: ["bomcp.control.handoff", "bomcp.progress.update"],
          timeout_seconds: 120,
        },
      },
    ),
    expectedHttp: 200,
    expectedTerminalKind: "execution.completed",
  });

  const toolCalls = getMcpToolCalls(result.envelopes, "bomcp.control.handoff");
  const failedCall = toolCalls.find((call) => call.status === "failed");
  if (failedCall) {
    throw new Error(`${prefix}: bomcp.control.handoff tool call failed: ${String(failedCall.error?.message ?? "unknown error")}`);
  }

  const handoffs = result.envelopes.filter((e: BomcpEnvelope) => e.kind === "control.handoff");
  if (handoffs.length === 0) {
    throw new Error(`${prefix}: expected at least one control.handoff envelope`);
  }
  const payload = getPayloadRecord(handoffs[0]);
  const next = typeof payload.next === "object" && payload.next !== null
    ? payload.next as Record<string, unknown>
    : {};
  assertEq(payload.kind, "continue_with_prompt", `${prefix} handoff kind`);
  assertEq(next.prompt_id, "review_patch", `${prefix} handoff prompt_id`);
  console.log(`[it] ${prefix}: handoff emitted correctly`);
}

// ---------------------------------------------------------------------------
// Scenario: Agent calls a BO-MCP tool with malformed params and sees rejection
// ---------------------------------------------------------------------------

export async function runInvalidParamsScenario(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  prefix: string,
) {
  const result = await executeRequest({
    context,
    name: prefix,
    request: buildRequest(
      backend,
      sourceRoot,
      "Call the bomcp.progress.update tool exactly once with arguments {\"percent\":\"fifty\"}. Do not coerce the value. If the tool call is rejected, set payload.content to 'invalid-params-enforced'. If it somehow succeeds, set payload.content to 'invalid-params-failed'.",
      {
        lease: {
          allowed_tools: ["bomcp.progress.update"],
          timeout_seconds: 120,
        },
      },
    ),
    expectedHttp: 200,
    expectedTerminalKind: "execution.completed",
  });

  const toolCalls = getMcpToolCalls(result.envelopes, "bomcp.progress.update");
  const failedCall = toolCalls.find((call) => call.status === "failed");
  const emittedProgressWithPercent = result.envelopes.filter((e: BomcpEnvelope) => {
    if (e.kind !== "progress.update") {
      return false;
    }
    const payload = getPayloadRecord(e);
    return "percent" in payload;
  });
  const terminal = result.terminal;

  if (!terminal) {
    throw new Error(`${prefix}: expected terminal envelope`);
  }
  assertContains(String(getPayloadContent(terminal)), "invalid-params-enforced", `${prefix} terminal invalid param acknowledgement`);
  if (toolCalls.length > 0 && !failedCall) {
    throw new Error(`${prefix}: expected failed mcp_tool_call telemetry for malformed params`);
  }
  if (emittedProgressWithPercent.length > 0) {
    throw new Error(`${prefix}: malformed progress.update params must not emit structured percent progress envelopes`);
  }
  console.log(`[it] ${prefix}: invalid BO-MCP params rejected correctly`);
}

// ---------------------------------------------------------------------------
// Scenario: Multiple BO-MCP calls in one execution preserve ordering
// ---------------------------------------------------------------------------

export async function runMultiCallScenario(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  prefix: string,
) {
  const result = await executeRequest({
    context,
    name: prefix,
    request: buildRequest(
      backend,
      sourceRoot,
      "Use the bomcp.progress.update tool with phase 'planning' and percent 10. Then use bomcp.control.handoff with kind 'continue_with_prompt', reason_code 'multi_step', and next.prompt_id 'followup_multi'. Then use bomcp.progress.update with phase 'done' and percent 90. Then set payload.content to 'multi-call-ok'.",
      {
        lease: {
          allowed_tools: ["bomcp.progress.update", "bomcp.control.handoff"],
          timeout_seconds: 120,
        },
      },
    ),
    expectedHttp: 200,
    expectedTerminalKind: "execution.completed",
  });

  const toolCalls = [
    ...getMcpToolCalls(result.envelopes, "bomcp.progress.update"),
    ...getMcpToolCalls(result.envelopes, "bomcp.control.handoff"),
  ];
  const failedCall = toolCalls.find((call) => call.status === "failed");
  if (failedCall) {
    throw new Error(`${prefix}: BO-MCP multi-call failed: ${String(failedCall.error?.message ?? "unknown error")}`);
  }

  const firstProgressIndex = result.envelopes.findIndex((env) => {
    if (env.kind !== "progress.update") return false;
    const payload = getPayloadRecord(env);
    return payload.phase === "planning" && payload.percent === 10;
  });
  const handoffIndex = result.envelopes.findIndex((env) => {
    if (env.kind !== "control.handoff") return false;
    const payload = getPayloadRecord(env);
    const next = typeof payload.next === "object" && payload.next !== null
      ? payload.next as Record<string, unknown>
      : {};
    return payload.kind === "continue_with_prompt" && payload.reason_code === "multi_step" && next.prompt_id === "followup_multi";
  });
  const secondProgressIndex = result.envelopes.findIndex((env) => {
    if (env.kind !== "progress.update") return false;
    const payload = getPayloadRecord(env);
    return payload.phase === "done" && payload.percent === 90;
  });

  if (firstProgressIndex === -1 || handoffIndex === -1 || secondProgressIndex === -1) {
    throw new Error(`${prefix}: expected planning progress, handoff, and done progress envelopes`);
  }
  if (!(firstProgressIndex < handoffIndex && handoffIndex < secondProgressIndex)) {
    throw new Error(`${prefix}: expected progress/handoff/progress ordering, got indices ${firstProgressIndex}/${handoffIndex}/${secondProgressIndex}`);
  }
  console.log(`[it] ${prefix}: multi-call BO-MCP ordering validated`);
}

// ---------------------------------------------------------------------------
// Scenario: Lease enforcement — agent can't call tools not in allowed_tools
// ---------------------------------------------------------------------------

export async function runLeaseEnforcementScenario(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  prefix: string,
) {
  const result = await executeRequest({
    context,
    name: prefix,
    request: buildRequest(backend, sourceRoot,
      "Try to use the bomcp.control.handoff tool with kind 'blocked' and reason_code 'test'. If the tool call fails or is rejected, set payload.content to 'lease-enforced'. If it succeeds, set payload.content to 'lease-not-enforced'.",
      {
        lease: {
          allowed_tools: ["bomcp.progress.update"],
          timeout_seconds: 120,
        },
      },
    ),
    expectedHttp: 200,
    expectedTerminalKind: "execution.completed",
  });

  const errors = result.envelopes.filter((e: BomcpEnvelope) => e.kind === "system.error");
  const leaseErrors = errors.filter((e: BomcpEnvelope) => {
    const payload = getPayloadRecord(e);
    return payload.code === "lease_tool_denied";
  });

  if (leaseErrors.length === 0) {
    throw new Error(`${prefix}: expected at least one lease_tool_denied system.error envelope`);
  }
  console.log(`[it] ${prefix}: lease enforcement confirmed — ${leaseErrors.length} lease_tool_denied error(s)`);
}

// ---------------------------------------------------------------------------
// Scenario: Envelope structure validation
// ---------------------------------------------------------------------------

export async function runEnvelopeStructureScenario(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  prefix: string,
) {
  const result = await executeRequest({
    context,
    name: prefix,
    request: buildRequest(backend, sourceRoot,
      "Set payload.content to 'envelope-ok'.",
      {
        lease: {
          allowed_tools: ["bomcp.progress.update"],
          timeout_seconds: 120,
        },
      },
    ),
    expectedHttp: 200,
    expectedTerminalKind: "execution.completed",
  });

  // Validate every envelope has required fields per spec
  for (const env of result.envelopes) {
    if (!env.message_id) throw new Error(`${prefix}: envelope missing message_id`);
    if (!env.kind) throw new Error(`${prefix}: envelope missing kind`);
    if (typeof env.sequence !== "number") throw new Error(`${prefix}: envelope missing sequence`);
    if (!env.timestamp) throw new Error(`${prefix}: envelope missing timestamp`);
    if (!env.sender?.type) throw new Error(`${prefix}: envelope missing sender.type`);
    if (!env.sender?.id) throw new Error(`${prefix}: envelope missing sender.id`);
    if (env.payload === undefined) throw new Error(`${prefix}: envelope missing payload`);
  }

  // Validate sequences are monotonically increasing
  for (let i = 1; i < result.envelopes.length; i++) {
    if (result.envelopes[i].sequence <= result.envelopes[i - 1].sequence) {
      throw new Error(`${prefix}: sequence not monotonic at index ${i}: ${result.envelopes[i - 1].sequence} → ${result.envelopes[i].sequence}`);
    }
  }

  // Validate first envelope is execution.started
  assertEq(result.envelopes[0].kind, "execution.started", `${prefix} first envelope`);

  // Validate execution_id is consistent across all envelopes that have it
  const execIds = new Set(result.envelopes.filter((e: BomcpEnvelope) => e.execution_id).map((e: BomcpEnvelope) => e.execution_id));
  if (execIds.size > 1) {
    throw new Error(`${prefix}: inconsistent execution_ids: ${JSON.stringify([...execIds])}`);
  }

  console.log(`[it] ${prefix}: all ${result.envelopes.length} envelopes have valid structure, monotonic sequences, consistent execution_id`);
}

// ---------------------------------------------------------------------------
// Scenario: Namespace reservation — bomcp MCP server name rejected
// ---------------------------------------------------------------------------

export async function runNamespaceReservationScenario(
  context: IntegrationContext,
  backend: IntegrationAgent,
  prefix: string,
) {
  const result = await executeRequest({
    context,
    name: prefix,
    request: {
      backend,
      execution_profile: { model: backend === "claude" ? "claude-sonnet-4-6" : "gpt-5" },
      task: { prompt: "This should be rejected." },
      tool_configuration: {
        mcp_servers: [{
          name: "bomcp",
          transport: "stdio" as const,
          command: "echo",
        }],
      },
    },
    expectedHttp: 200,
  });

  const errorEnv = result.envelopes.find((e: BomcpEnvelope) => e.kind === "system.error");
  if (!errorEnv) {
    throw new Error(`${prefix}: expected system.error envelope for reserved namespace`);
  }
  const payload = getPayloadRecord(errorEnv);
  assertContains(String(payload.message ?? ""), "reserved", `${prefix} error message`);
  console.log(`[it] ${prefix}: bomcp namespace reservation enforced`);
}

interface McpToolCallItem {
  tool: string;
  status?: string;
  error?: { message?: string };
}

function getMcpToolCalls(envelopes: BomcpEnvelope[], toolName: string): McpToolCallItem[] {
  const calls: McpToolCallItem[] = [];
  for (const envelope of envelopes) {
    if (envelope.kind !== "progress.chunk") {
      continue;
    }
    const payload = getPayloadRecord(envelope);
    if (typeof payload.text !== "string") {
      continue;
    }
    const line = payload.text.trim();
    if (!line.startsWith("{")) {
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const item = typeof parsed.item === "object" && parsed.item !== null
      ? parsed.item as Record<string, unknown>
      : undefined;
    if (item?.type !== "mcp_tool_call" || item.tool !== toolName) {
      continue;
    }
    const error = typeof item.error === "object" && item.error !== null
      ? item.error as { message?: string }
      : undefined;
    calls.push({
      tool: toolName,
      status: typeof item.status === "string" ? item.status : undefined,
      error,
    });
  }
  return calls;
}
