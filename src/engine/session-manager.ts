import type { BackendName, DurabilityKind, NormalizedExecutionRequest } from "../types.ts";
import type { SessionRecord, BoStaffRepository } from "../persistence/types.ts";
import { generateHandle, nowIso } from "../utils.ts";
import { RequestResolutionError } from "../errors.ts";

export interface SessionResolution {
  internal_handle: string;
  public_handle: string | null;
  persist_on_initialize: boolean;
  continued_from?: string;
  forked_from?: string;
  continuity_kind: "native" | "managed" | "none";
  durability_kind: DurabilityKind;
  provider_session_id?: string;
  continuation_capsule?: SessionRecord["continuation_capsule"];
  record?: SessionRecord;
}

export class SessionManager {
  private readonly repository: BoStaffRepository;

  constructor(repository: BoStaffRepository) {
    this.repository = repository;
  }

  async resolve(input: {
    request: NormalizedExecutionRequest;
    backend: BackendName;
    sourceRoot: string | null;
  }): Promise<SessionResolution> {
    const { request } = input;
    const timestamp = nowIso();

    if (request.session.mode === "ephemeral") {
      const handle = generateHandle("sess");
      return {
        internal_handle: handle,
        public_handle: null,
        persist_on_initialize: false,
        continuity_kind: "none",
        durability_kind: "ephemeral"
      };
    }

    if (request.session.mode === "new") {
      const handle = generateHandle("sess");
      const record: SessionRecord = {
        handle,
        backend: input.backend,
        continuity_kind: "none",
        durability_kind: "persistent",
        created_at: timestamp,
        updated_at: timestamp,
        workspace_topology: request.workspace.topology,
        source_root: input.sourceRoot,
        workspace_scope_mode: request.workspace.scope.mode,
        workspace_scope_subpath: request.workspace.scope.mode === "subpath"
          ? request.workspace.scope.subpath
          : undefined
      };
      return {
        internal_handle: handle,
        public_handle: handle,
        persist_on_initialize: true,
        continuity_kind: "none",
        durability_kind: "persistent",
        record
      };
    }

    const existingHandle = request.session.handle;
    if (!existingHandle) {
      throw new RequestResolutionError(`session.handle is required for mode ${request.session.mode}`);
    }
    const existing = await this.repository.getSession(existingHandle);
    if (!existing) {
      throw new RequestResolutionError(`Unknown session handle: ${existingHandle}`, "unknown_session_handle");
    }
    if (existing.durability_kind === "ephemeral") {
      throw new RequestResolutionError(
        `Ephemeral session handles cannot be continued or forked: ${existingHandle}`,
        "ephemeral_session_handle"
      );
    }

    if (request.session.mode === "continue") {
      const continuityKind = existing.backend === input.backend
        && existing.provider_session_id
        && request.workspace.kind === "provided"
        && existing.workspace_topology === request.workspace.topology
        && existing.source_root === input.sourceRoot
        && existing.workspace_scope_mode === request.workspace.scope.mode
        && existing.workspace_scope_subpath === request.workspace.scope.subpath
        ? "native"
        : "managed";
      return {
        internal_handle: existing.handle,
        public_handle: existing.handle,
        persist_on_initialize: false,
        continued_from: existing.handle,
        continuity_kind: continuityKind,
        durability_kind: existing.durability_kind,
        provider_session_id: continuityKind === "native" ? existing.provider_session_id : undefined,
        continuation_capsule: continuityKind === "managed" ? existing.continuation_capsule : undefined,
        record: {
          ...existing,
          backend: input.backend,
          continuity_kind: continuityKind,
          continued_from: existing.handle,
          workspace_topology: request.workspace.topology,
          source_root: input.sourceRoot,
          workspace_scope_mode: request.workspace.scope.mode,
          workspace_scope_subpath: request.workspace.scope.mode === "subpath"
            ? request.workspace.scope.subpath
            : undefined,
          updated_at: timestamp
        }
      };
    }

    const handle = generateHandle("sess");
    const record: SessionRecord = {
      handle,
      backend: input.backend,
      continuity_kind: "managed",
      durability_kind: "persistent",
      created_at: timestamp,
      updated_at: timestamp,
      forked_from: existing.handle,
      workspace_topology: request.workspace.topology,
      source_root: input.sourceRoot,
      workspace_scope_mode: request.workspace.scope.mode,
      workspace_scope_subpath: request.workspace.scope.mode === "subpath"
        ? request.workspace.scope.subpath
        : undefined,
      continuation_capsule: existing.continuation_capsule
    };
    return {
      internal_handle: handle,
      public_handle: handle,
      persist_on_initialize: true,
      forked_from: existing.handle,
      continuity_kind: "managed",
      durability_kind: "persistent",
      continuation_capsule: record.continuation_capsule,
      record
    };
  }
}
