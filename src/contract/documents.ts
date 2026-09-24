// The published contract: a JSON Schema document with every public shape, and an OpenAPI 3.1 description of `/v1`.
// Built from `schema.ts` only; `npm run contract` writes them to `contract/`, and a test keeps them current.

import { CONTRACT_VERSION, SCHEMAS } from "./schema.ts";
import { VERSION } from "../version.ts";

type Json = Record<string, unknown>;

/** `contract/bo.v1.schema.json`. */
export function schemaDocument(): Json {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: `urn:bo:contract:v${CONTRACT_VERSION}`,
    title: `bo contract v${CONTRACT_VERSION}`,
    description: "Every public shape of bo. Unions discriminated by a tag use `oneOf` with the OpenAPI `discriminator` keyword.",
    definitions: plain(SCHEMAS),
  };
}

const ref = (name: keyof typeof SCHEMAS) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: keyof typeof SCHEMAS) => ({ content: { "application/json": { schema: ref(name) } } });
const problems = (...statuses: number[]) => Object.fromEntries(statuses.map((s) => [String(s), {
  description: "a problem (RFC 9457)", content: { "application/problem+json": { schema: ref("Problem") } },
}]));
const idParam = (name: string, description: string) => ({ name, in: "path", required: true, schema: { type: "string" }, description });

/** `contract/openapi.json`. */
export function openApiDocument(): Json {
  const runId = idParam("id", "a run id");
  const sessionId = idParam("id", "a session id");
  return {
    openapi: "3.1.0",
    info: { title: "bo", version: VERSION, description: `Contract v${CONTRACT_VERSION}. Within /v1, changes are additive only: clients ignore unknown fields, item types and action kinds.` },
    components: {
      schemas: plain(SCHEMAS),
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "required when the server has a token" } },
    },
    security: [{}, { bearer: [] }],
    paths: {
      "/v1/engines": { get: { summary: "Engines, their models and efforts", responses: { 200: { description: "every configured engine", content: { "application/json": { schema: { type: "array", items: ref("EngineInfo") } } } } } } },
      "/v1/runs": {
        post: {
          summary: "Start a run",
          parameters: [{ name: "Idempotency-Key", in: "header", schema: { type: "string" }, description: "a replay returns the same run" }],
          requestBody: { required: true, ...json("RunSpec") },
          responses: { 200: { description: "a replayed run", ...json("Run") }, 201: { description: "the new run", ...json("Run") }, ...problems(400, 401, 413, 415, 422, 429) },
        },
        get: { summary: "Runs of the last 10 minutes, active first", responses: { 200: { description: "runs", content: { "application/json": { schema: { type: "array", items: ref("Run") } } } } } },
      },
      "/v1/runs/{id}": { get: { summary: "A run", parameters: [runId], responses: { 200: { description: "the run", ...json("Run") }, ...problems(404) } } },
      "/v1/runs/{id}/events": {
        get: {
          summary: "The run's events as server-sent events; resume with Last-Event-ID",
          parameters: [runId, { name: "Last-Event-ID", in: "header", schema: { type: "integer" } }],
          responses: { 200: { description: "`event:` is the StreamEvent's event, `data:` its data, `id:` its id (deltas have none)", content: { "text/event-stream": { schema: ref("StreamEvent") } } }, ...problems(404, 429) },
        },
      },
      "/v1/runs/{id}/messages": { post: { summary: "Steer a running run", parameters: [runId], requestBody: { required: true, ...json("MessageBody") }, responses: { 202: { description: "queued; it appears as a user message item once the engine accepts it" }, ...problems(404, 409, 422, 429) } } },
      "/v1/runs/{id}/items/{item}/response": { post: { summary: "Answer an awaiting action or question", parameters: [runId, idParam("item", "an item id")], requestBody: { required: true, ...json("ResponseBody") }, responses: { 204: { description: "answered" }, ...problems(404, 409, 422) } } },
      "/v1/runs/{id}/cancel": { post: { summary: "Cancel a run", parameters: [runId], responses: { 202: { description: "cancelling" }, ...problems(404) } } },
      "/v1/sessions": { get: { summary: "Sessions, most recently used first", parameters: [{ name: "workspace", in: "query", schema: { type: "string" }, description: "an absolute path: that workspace's sessions" }], responses: { 200: { description: "sessions", content: { "application/json": { schema: { type: "array", items: ref("Session") } } } }, ...problems(422) } } },
      "/v1/sessions/{id}": {
        get: { summary: "A session", parameters: [sessionId], responses: { 200: { description: "the session", ...json("Session") }, ...problems(404) } },
        delete: { summary: "Forget a session and its history (the engine's own history is untouched)", parameters: [sessionId], responses: { 204: { description: "forgotten" }, ...problems(404) } },
      },
      "/v1/sessions/{id}/runs": { get: { summary: "A session's finished runs, oldest first", parameters: [sessionId], responses: { 200: { description: "runs with their items", content: { "application/json": { schema: { type: "array", items: ref("SessionRun") } } } }, ...problems(404) } } },
    },
  };
}

/** TypeBox schemas as plain JSON (no symbols, stable key order as declared). */
function plain(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}
