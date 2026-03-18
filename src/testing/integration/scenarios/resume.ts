import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { IntegrationContext } from "../fixtures.ts";
import { pauseStep } from "../fixtures.ts";
import {
  assertContains,
  assertEq,
  assertNoErrors,
  assertTextAbsentFromGatewaySources,
  executeRequest,
  fetchJson,
  getPayloadRecord,
  getPayloadContent
} from "../assertions.ts";
import { buildRequest, uniqueMarker, type IntegrationAgent } from "./common.ts";

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
  const { json } = await executeRequest({
    context,
    name,
    request: buildRequest(
      backend,
      sourceRoot,
      "What is the integration marker for this repository? Return it in payload.content."
    ),
    expectedHttp: 200,
    expectedStatuses: ["completed", "partial"]
  });
  assertEq(getPayloadContent(json), expectedMarker, `${backend} instruction marker`);
  assertNoErrors(json, `${backend} instruction discovery`);
  await pauseStep(context);
}

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
    token
  });
  const handle = first.json.session.handle;
  assertNoErrors(first.json, `${backend} native continuation seed`);
  await pauseStep(context);

  const second = await executeRequest({
    context,
    name: `${prefix}-continue`,
    request: buildRequest(
      backend,
      sourceRoot,
      "Return the remembered token from the previous execution in payload.content.",
      {
        session: {
          mode: "continue",
          handle
        }
      }
    ),
    expectedHttp: 200,
    expectedStatuses: ["completed", "partial"]
  });
  assertEq(second.json.session.handle, handle, `${backend} native continuation handle`);
  assertEq(second.json.session.continuity_kind, "native", `${backend} native continuation kind`);
  assertContains(String(getPayloadContent(second.json)), token, `${backend} native continuation token`);
  if (!handle) {
    throw new Error(`${backend} native continuation returned no session handle`);
  }
  await assertSessionApis(context, handle, `${backend} native continuation`);
  await pauseStep(context);
}

export async function runManagedContinuation(
  context: IntegrationContext,
  seedBackend: IntegrationAgent,
  continueBackend: IntegrationAgent,
  sourceRoot: string,
  token: string,
  prefix: string
) {
  const first = await executeSeedWithRememberedToken({
    context,
    backend: seedBackend,
    sourceRoot,
    prefix,
    content: "managed-seeded",
    token
  });
  await pauseStep(context);

  const second = await executeRequest({
    context,
    name: `${prefix}-continue`,
    request: buildRequest(
      continueBackend,
      sourceRoot,
      "Read the managed continuation capsule and return the remembered token in payload.content.",
      {
        session: {
          mode: "continue",
          handle: first.json.session.handle
        }
      }
    ),
    expectedHttp: 200,
    expectedStatuses: ["completed", "partial"]
  });
  assertEq(second.json.session.handle, first.json.session.handle, `${prefix} managed continuation handle`);
  assertEq(second.json.session.continuity_kind, "managed", `${prefix} managed continuation kind`);
  assertContains(String(getPayloadContent(second.json)), token, `${prefix} managed continuation token`);
  await pauseStep(context);
}

export async function runForkContinuation(
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
    content: "fork-seeded",
    token
  });
  await pauseStep(context);

  const second = await executeRequest({
    context,
    name: `${prefix}-fork`,
    request: buildRequest(
      backend,
      sourceRoot,
      "Read the managed continuation capsule and return the remembered token in payload.content.",
      {
        session: {
          mode: "fork",
          handle: first.json.session.handle
        }
      }
    ),
    expectedHttp: 200,
    expectedStatuses: ["completed", "partial"]
  });
  if (second.json.session.handle === first.json.session.handle) {
    throw new Error(`${backend} fork continuation should create a new session handle`);
  }
  assertEq(second.json.session.forked_from, first.json.session.handle, `${backend} fork parent`);
  assertEq(second.json.session.continuity_kind, "managed", `${backend} fork continuity`);
  assertContains(String(getPayloadContent(second.json)), token, `${backend} fork token`);
  await pauseStep(context);
}

export async function runSessionDeletion(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  prefix: string
) {
  const response = await executeRequest({
    context,
    name: `${prefix}-create`,
    request: buildRequest(backend, sourceRoot, "Set payload.content to cleanup-ok."),
    expectedHttp: 200,
    expectedStatuses: ["completed", "partial"]
  });
  const handle = response.json.session.handle;
  if (!handle) {
    throw new Error(`${prefix} session deletion requires a persisted session handle`);
  }
  const deleted = await fetchJson<{ deleted: boolean; handle: string }>({
    context,
    method: "DELETE",
    path: `/sessions/${encodeURIComponent(handle)}`,
    expectedHttp: 200,
    name: `${prefix}-delete`
  });
  assertEq(deleted.deleted, true, `${prefix} deleted`);
  await fetchJson<{ error: { code: string; message: string } }>({
    context,
    method: "GET",
    path: `/sessions/${encodeURIComponent(handle)}`,
    expectedHttp: 404,
    name: `${prefix}-get-missing`
  });
  await pauseStep(context);
}

export async function runUnknownSessionRejection(
  context: IntegrationContext,
  backend: IntegrationAgent,
  sourceRoot: string,
  prefix: string
) {
  const response = await executeRequest({
    context,
    name: prefix,
    request: buildRequest(
      backend,
      sourceRoot,
      "Continue a missing session.",
      {
        session: {
          mode: "continue",
          handle: "sess_missing_integration"
        }
      }
    ),
    expectedHttp: 400,
    expectedStatuses: ["rejected"]
  });
  assertContains(response.json.errors[0]?.message ?? "", "Unknown session handle", `${backend} unknown session rejection`);
  await pauseStep(context);
}

async function assertSessionApis(
  context: IntegrationContext,
  handle: string,
  label: string
) {
  const detail = await fetchJson<{ session: {
    handle: string;
    latest_execution_id?: string;
    latest_status?: string;
  } }>({
    context,
    method: "GET",
    path: `/sessions/${encodeURIComponent(handle)}`,
    expectedHttp: 200,
    name: `${label}-detail`
  });
  assertEq(detail.session.handle, handle, `${label} detail handle`);
  if (typeof detail.session.latest_execution_id !== "string" || detail.session.latest_execution_id.length === 0) {
    throw new Error(`${label}: expected latest_execution_id to be populated`);
  }
  const listing = await fetchJson<{ sessions: Array<{ handle: string }> }>({
    context,
    method: "GET",
    path: "/sessions",
    expectedHttp: 200,
    name: `${label}-list`
  });
  if (!listing.sessions.some((entry) => entry.handle === handle)) {
    throw new Error(`${label}: expected session listing to include ${handle}`);
  }
}

export function managedContinuationToken(prefix: string): string {
  return uniqueMarker(prefix);
}

async function executeSeedWithRememberedToken(input: {
  context: IntegrationContext;
  backend: IntegrationAgent;
  sourceRoot: string;
  prefix: string;
  content: string;
  token: string;
}) {
  let lastResponse: Awaited<ReturnType<typeof executeRequest>> | undefined;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await executeRequest({
      context: input.context,
      name: attempt === 1 ? `${input.prefix}-seed` : `${input.prefix}-seed-retry-${attempt}`,
      request: buildRequest(
        input.backend,
        input.sourceRoot,
        `Return compact JSON with payload.content='${input.content}' and payload.remembered_token='${input.token}'.`,
        {
          output: {
            format: "custom",
            schema: {
              type: "object",
              required: ["content", "remembered_token"],
              additionalProperties: false,
              properties: {
                content: { type: "string" },
                remembered_token: { type: "string" }
              }
            }
          }
        }
      ),
      expectedHttp: 200,
      expectedStatuses: ["completed", "partial"]
    });
    lastResponse = response;
    const payload = getPayloadRecord(response.json);
    const rememberedToken = typeof payload.remembered_token === "string" ? payload.remembered_token : "";
    if (rememberedToken.includes(input.token)) {
      return response;
    }
  }
  throw new Error(
    `${input.prefix} seed remembered_token missing expected token '${input.token}'; final payload=${JSON.stringify(lastResponse?.json.result.payload ?? {})}`
  );
}
