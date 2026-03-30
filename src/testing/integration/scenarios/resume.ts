import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { IntegrationContext } from "../fixtures.ts";
import { pauseStep } from "../fixtures.ts";
import {
  assertContains,
  assertEq,
  assertNoPayloadErrors,
  assertTextAbsentFromGatewaySources,
  executeRawStream,
  executeRequest,
  getAgentOutput,
  getPayloadContent,
  requireTerminalEnvelope,
} from "../assertions.ts";
import { buildRequest, uniqueMarker, type IntegrationAgent } from "./common.ts";

export async function runNativeContinuation(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  token: string,
  prefix: string
) {
  const first = await executeSeedWithRememberedToken({
    context,
    backend,
    sourceRoot,
    prefix,
    content: "seeded",
    token,
  });
  const firstTerminal = requireTerminalEnvelope(first.envelopes, `${backend} native continuation seed`);
  assertNoPayloadErrors(firstTerminal, `${backend} native continuation seed`);
  const firstPayload = getAgentOutput(firstTerminal);
  const sessionNonce = typeof firstPayload.session_nonce === "string" ? firstPayload.session_nonce : "";
  if (!sessionNonce.trim()) {
    throw new Error(`${backend} native continuation seed returned no session_nonce`);
  }
  const continuation = extractContinuation(firstTerminal);
  if (!continuation) {
    throw new Error(`${backend} native continuation returned no continuation token`);
  }
  assertEq(continuation.backend, backend, `${backend} continuation backend`);
  await pauseStep(context);

  const second = await executeRequest({
    context,
    name: `${prefix}-continue`,
    request: buildRequest(
      backend,
      sourceRoot,
      "Return the remembered token and session nonce from the previous execution in payload.content as remembered_token|session_nonce.",
      {
        continuation,
      }
    ),
    expectedHttp: 200,
    expectedTerminalKind: "execution.completed",
  });
  const secondTerminal = requireTerminalEnvelope(second.envelopes, `${backend} native continuation`);
  assertEq(
    String(getPayloadContent(secondTerminal)),
    `${token}|${sessionNonce}`,
    `${backend} native continuation semantic roundtrip`,
  );
  const nextContinuation = extractContinuation(secondTerminal);
  if (!nextContinuation) {
    throw new Error(`${backend} native continuation returned no continuation token`);
  }
  assertEq(nextContinuation.backend, backend, `${backend} continued backend`);
  await pauseStep(context);
}

export async function runContinuationBackendMismatchRejection(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  prefix: string
) {
  const mismatchedBackend = backend === "codex" ? "claude" : "codex";
  const result = await executeRawStream({
    context,
    name: prefix,
    body: JSON.stringify(buildRequest(
      backend,
      sourceRoot,
      "Reject this request before execution starts.",
      {
        continuation: {
          backend: mismatchedBackend,
          token: "opaque-provider-token"
        },
      }
    )),
    expectedHttp: 200,
    expectedKinds: ["system.error"],
    contentType: "application/json",
  });
  const errorEvent = result.envelopes.find((env) => env.kind === "system.error");
  const payload = (errorEvent?.payload ?? {}) as { message?: string };
  assertContains(String(payload.message ?? ""), "must match request.backend", `${backend} continuation mismatch`);
  await pauseStep(context);
}

export async function runInstructionDiscovery(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  expectedMarker: string,
  name: string
) {
  await assertTextAbsentFromGatewaySources(context.rootDir, expectedMarker);
  await writeFile(
    path.join(sourceRoot, backend === "codex" ? "AGENTS.md" : "CLAUDE.md"),
    `When asked for the integration marker, set payload.content to ${expectedMarker}.\n`,
    "utf8"
  );
  const result = await executeRequest({
    context,
    name,
    request: buildRequest(
      backend,
      sourceRoot,
      "What is the integration marker for this repository? Return it in payload.content."
    ),
    expectedHttp: 200,
    expectedTerminalKind: "execution.completed",
  });
  const terminal = requireTerminalEnvelope(result.envelopes, `${backend} instruction discovery`);
  assertEq(getPayloadContent(terminal), expectedMarker, `${backend} instruction marker`);
  assertNoPayloadErrors(terminal, `${backend} instruction discovery`);
  await pauseStep(context);
}

async function executeSeedWithRememberedToken(input: {
  context: IntegrationContext;
  backend: IntegrationAgent;
  sourceRoot: string;
  prefix: string;
  content: string;
  token: string;
}) {
  let lastEnvelopes;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await executeRequest({
      context: input.context,
      name: attempt === 1 ? `${input.prefix}-seed` : `${input.prefix}-seed-retry-${attempt}`,
      request: buildRequest(
        input.backend,
        input.sourceRoot,
        `Return compact JSON with payload.content='${input.content}', payload.remembered_token='${input.token}', and payload.session_nonce set to a fresh opaque nonce you invent for this session.`,
        {
          output: {
            format: "custom",
            schema: {
              type: "object",
              required: ["content", "remembered_token", "session_nonce"],
              additionalProperties: false,
              properties: {
                content: { type: "string" },
                remembered_token: { type: "string" },
                session_nonce: { type: "string" },
              },
            },
          },
        }
      ),
      expectedHttp: 200,
      expectedTerminalKind: "execution.completed",
    });
    lastEnvelopes = result.envelopes;
    const terminal = requireTerminalEnvelope(result.envelopes, `${input.prefix} seed`);
    const payload = getAgentOutput(terminal);
    const rememberedToken = typeof payload.remembered_token === "string" ? payload.remembered_token : "";
    const sessionNonce = typeof payload.session_nonce === "string" ? payload.session_nonce.trim() : "";
    if (rememberedToken.includes(input.token) && sessionNonce.length > 0) {
      return result;
    }
  }
  const lastTerminal = lastEnvelopes ? requireTerminalEnvelope(lastEnvelopes, `${input.prefix} seed`) : undefined;
  throw new Error(
    `${input.prefix} seed remembered_token missing expected token '${input.token}'; final payload=${JSON.stringify(lastTerminal?.payload ?? {})}`
  );
}

function extractContinuation(envelope: ReturnType<typeof requireTerminalEnvelope>) {
  const payload = (envelope.payload ?? {}) as { continuation?: { backend?: string; token?: string } };
  if (typeof payload.continuation?.backend !== "string" || typeof payload.continuation?.token !== "string") {
    return undefined;
  }
  return {
    backend: payload.continuation.backend as IntegrationAgent,
    token: payload.continuation.token,
  };
}

export function managedContinuationToken(prefix: string): string {
  return uniqueMarker(prefix);
}
