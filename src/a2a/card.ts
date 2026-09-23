// A2A Agent Card (spec v1.0.1, https://github.com/a2aproject/A2A/tree/v1.0.1).

import type { AgentCard } from "@a2a-js/sdk";
import type { EngineInfo } from "../model.ts";
import { VERSION } from "../version.ts";

export const A2A_VERSION = "1.0";
export const BO_EXTENSION = "urn:bo:a2a:run:v1";

export function agentCard(base: string, engines: readonly EngineInfo[], bearer: boolean): AgentCard {
  return {
    name: "bo",
    description: "Coding agents (Claude Code, Codex) on a local workspace",
    supportedInterfaces: [{ url: `${base}/a2a`, protocolBinding: "JSONRPC", protocolVersion: A2A_VERSION, tenant: "" }],
    provider: undefined,
    version: VERSION,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [{
        uri: BO_EXTENSION,
        description: "RunSpec (minus input) in message metadata; bo items in status-update metadata",
        required: false, params: undefined,
      }],
    },
    defaultInputModes: ["text/plain", "application/json", "image/png", "image/jpeg", "image/gif", "image/webp"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: engines.filter((engine) => engine.available).map((engine) => ({
      id: engine.id, name: engine.id,
      description: `Run ${engine.id} (${engine.models.map((model) => model.id).join(", ") || "default model"}) on a workspace`,
      tags: ["coding"], examples: [],
      inputModes: [], outputModes: [], securityRequirements: [],
    })),
    ...(bearer ? {
      securitySchemes: { bearer: { scheme: { $case: "httpAuthSecurityScheme", value: { scheme: "Bearer", description: "", bearerFormat: "" } } } },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    } : { securitySchemes: {}, securityRequirements: [] }),
    signatures: [],
  };
}
