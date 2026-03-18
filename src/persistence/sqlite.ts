import path from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  ArtifactRecord,
  BoStaffEvent,
  CapabilityName,
  CapabilityOutcome,
  ControlGateRecord
} from "../types.ts";
import type {
  AppendExecutionEventInput,
  BoStaffRepository,
  CommitTerminalExecutionInput,
  ExecutionEventPage,
  ExecutionEventPageCursor,
  ExecutionRecord,
  InitializeExecutionInput,
  SessionPage,
  SessionPageCursor,
  SessionRecord,
  StoredExecutionSnapshot,
  WorkspaceRecord
} from "./types.ts";
import { isTerminalStatus } from "../core/index.ts";
import { parseStoredContinuationCapsule } from "./codec.ts";
import { stableJson } from "../utils.ts";

export class SqliteBoStaffRepository implements BoStaffRepository {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "bo-staff.sqlite"));
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.initializeSchema();
  }

  async getSession(handle: string): Promise<SessionRecord | undefined> {
    this.assertOpen();
    const row = this.db.prepare(`
      SELECT *
      FROM sessions
      WHERE handle = ?
    `).get(handle) as SessionRow | undefined;
    return row ? mapSessionRow(row) : undefined;
  }

  async listSessionsPage(input: { limit: number; after?: SessionPageCursor }): Promise<SessionPage> {
    this.assertOpen();
    const rows = this.db.prepare(`
      SELECT *
      FROM sessions
      WHERE (
        ? IS NULL
        OR created_at > ?
        OR (created_at = ? AND handle > ?)
      )
      ORDER BY created_at ASC, handle ASC
      LIMIT ?
    `).all(
      input.after?.created_at ?? null,
      input.after?.created_at ?? null,
      input.after?.created_at ?? null,
      input.after?.handle ?? null,
      input.limit + 1
    ) as unknown as SessionRow[];
    const pageRows = rows.slice(0, input.limit);
    const nextRow = rows.length > input.limit ? pageRows[pageRows.length - 1] : undefined;
    return {
      sessions: pageRows.map(mapSessionRow),
      next_after: nextRow
        ? {
          created_at: nextRow.created_at,
          handle: nextRow.handle
        }
        : undefined
    };
  }

  async countSessions(): Promise<number> {
    this.assertOpen();
    const row = this.db.prepare(`
      SELECT COUNT(*) AS session_count
      FROM sessions
    `).get() as { session_count: number | bigint };
    return Number(row.session_count);
  }

  async getExecution(executionId: string): Promise<StoredExecutionSnapshot | undefined> {
    this.assertOpen();
    const executionRow = this.db.prepare(`
      SELECT *
      FROM executions
      WHERE execution_id = ?
    `).get(executionId) as ExecutionRow | undefined;
    if (!executionRow) {
      return undefined;
    }

    const sessionRow = this.db.prepare(`
      SELECT *
      FROM sessions
      WHERE handle = ?
    `).get(executionRow.session_handle) as SessionRow | undefined;
    const workspaceRow = this.db.prepare(`
      SELECT *
      FROM workspace_records
      WHERE execution_id = ?
    `).get(executionId) as WorkspaceRow | undefined;
    if (!workspaceRow) {
      return undefined;
    }

    const capabilityRows = this.db.prepare(`
      SELECT capability, outcome_json
      FROM capability_outcomes
      WHERE execution_id = ?
    `).all(executionId) as Array<{ capability: CapabilityName; outcome_json: string }>;
    const artifactRows = this.db.prepare(`
      SELECT artifact_json
      FROM artifacts
      WHERE execution_id = ?
      ORDER BY artifact_id ASC
    `).all(executionId) as Array<{ artifact_json: string }>;
    const controlGateRows = this.db.prepare(`
      SELECT gate_json
      FROM control_gates
      WHERE execution_id = ?
      ORDER BY control_gate_id ASC
    `).all(executionId) as Array<{ gate_json: string }>;

    return {
      execution: mapExecutionRow(executionRow),
      session: sessionRow ? mapSessionRow(sessionRow) : undefined,
      workspace: mapWorkspaceRow(workspaceRow),
      capability_outcomes: Object.fromEntries(
        capabilityRows.map((row) => [row.capability, JSON.parse(row.outcome_json) as CapabilityOutcome])
      ) as Record<CapabilityName, CapabilityOutcome>,
      artifacts: artifactRows.map((row) => JSON.parse(row.artifact_json) as ArtifactRecord),
      control_gates: controlGateRows.map((row) => JSON.parse(row.gate_json) as ControlGateRecord)
    };
  }

  async getExecutionEvents(executionId: string): Promise<BoStaffEvent[]> {
    this.assertOpen();
    const rows = this.db.prepare(`
      SELECT event_json
      FROM execution_events
      WHERE execution_id = ?
      ORDER BY sequence_no ASC
    `).all(executionId) as Array<{ event_json: string }>;
    return rows.map((row) => JSON.parse(row.event_json) as BoStaffEvent);
  }

  async getExecutionEventsPage(input: {
    execution_id: string;
    limit: number;
    after?: ExecutionEventPageCursor;
  }): Promise<ExecutionEventPage> {
    this.assertOpen();
    const rows = this.db.prepare(`
      SELECT sequence_no, event_json
      FROM execution_events
      WHERE execution_id = ?
        AND (? IS NULL OR sequence_no > ?)
      ORDER BY sequence_no ASC
      LIMIT ?
    `).all(
      input.execution_id,
      input.after?.sequence_no ?? null,
      input.after?.sequence_no ?? null,
      input.limit + 1
    ) as Array<{ sequence_no: number; event_json: string }>;
    const pageRows = rows.slice(0, input.limit);
    const nextRow = rows.length > input.limit ? pageRows[pageRows.length - 1] : undefined;
    return {
      events: pageRows.map((row) => JSON.parse(row.event_json) as BoStaffEvent),
      next_after: nextRow
        ? {
          sequence_no: Number(nextRow.sequence_no)
        }
        : undefined
    };
  }

  async deleteSession(handle: string): Promise<boolean> {
    this.assertOpen();
    const result = this.db.prepare(`
      DELETE FROM sessions
      WHERE handle = ?
    `).run(handle);
    return Number(result.changes ?? 0) > 0;
  }

  async pruneSessionlessTerminalExecutions(before: string): Promise<number> {
    this.assertOpen();
    const result = this.db.prepare(`
      DELETE FROM executions
      WHERE session_handle IS NULL
        AND completed_at IS NOT NULL
        AND completed_at < ?
    `).run(before);
    return Number(result.changes ?? 0);
  }

  async recoverInterruptedExecutions(): Promise<void> {
    this.assertOpen();
    const rows = this.db.prepare(`
      SELECT execution_id, status
      FROM executions
      WHERE completed_at IS NULL
    `).all() as Array<{ execution_id: string; status: ExecutionRecord["status"] }>;
    const update = this.db.prepare(`
      UPDATE executions
      SET
        status = 'failed',
        retryable = 1,
        interruption_reason = 'server_restart',
        completed_at = updated_at
      WHERE execution_id = ?
    `);
    for (const row of rows) {
      if (!isTerminalStatus(row.status)) {
        update.run(row.execution_id);
      }
    }
  }

  async initializeExecution(input: InitializeExecutionInput): Promise<void> {
    this.assertOpen();
    this.withTransaction(() => {
      if (input.session_record) {
        this.upsertSession(input.session_record);
      }
      this.upsertExecution(input.execution_record);
      this.replaceCapabilityOutcomes(input.execution_record.execution_id, input.capability_outcomes);
      this.upsertWorkspaceRecord(input.workspace_record);
    });
  }

  async appendExecutionEvent(input: AppendExecutionEventInput): Promise<number> {
    this.assertOpen();
    return this.withTransaction(() => {
      const nextSequence = this.nextSequence(input.execution_id);
      this.db.prepare(`
        INSERT INTO execution_events (execution_id, sequence_no, event_json)
        VALUES (?, ?, ?)
      `).run(input.execution_id, nextSequence, stableJson(input.event));
      if (input.artifacts) {
        this.replaceArtifacts(input.execution_id, input.artifacts);
      }
      if (input.control_gates) {
        this.replaceControlGates(input.execution_id, input.control_gates);
      }
      return nextSequence;
    });
  }

  async commitTerminalExecution(input: CommitTerminalExecutionInput): Promise<void> {
    this.assertOpen();
    this.withTransaction(() => {
      const firstSequence = this.nextSequence(input.execution_record.execution_id);
      const terminalEventSequence = firstSequence + input.terminal_events.length - 1;
      if (input.session_record) {
        this.upsertSession(input.session_record);
      }
      this.upsertExecution({
        ...input.execution_record,
        response_snapshot: input.response_snapshot,
        usage: input.usage,
        terminal_event_sequence: terminalEventSequence
      });
      this.appendExecutionEvents(input.execution_record.execution_id, firstSequence, input.terminal_events);
      this.replaceArtifacts(input.execution_record.execution_id, input.artifacts);
      this.replaceControlGates(input.execution_record.execution_id, input.control_gates);
      this.replaceCapabilityOutcomes(input.execution_record.execution_id, input.capability_outcomes);
      this.upsertWorkspaceRecord(input.workspace_record);
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        handle TEXT PRIMARY KEY,
        backend TEXT NOT NULL,
        continuity_kind TEXT NOT NULL,
        durability_kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        continued_from TEXT,
        forked_from TEXT,
        provider_session_id TEXT,
        latest_execution_id TEXT,
        latest_status TEXT,
        workspace_topology TEXT NOT NULL,
        source_root TEXT,
        workspace_scope_mode TEXT,
        workspace_scope_subpath TEXT,
        continuation_capsule_json TEXT
      );

      CREATE TABLE IF NOT EXISTS executions (
        execution_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        session_handle TEXT,
        backend TEXT NOT NULL,
        status TEXT NOT NULL,
        degraded INTEGER NOT NULL,
        retryable INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        request_snapshot_json TEXT NOT NULL,
        response_snapshot_json TEXT,
        execution_profile_json TEXT NOT NULL,
        usage_json TEXT,
        terminal_event_sequence INTEGER,
        provider_session_id TEXT,
        interruption_reason TEXT,
        FOREIGN KEY (session_handle) REFERENCES sessions(handle) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS execution_events (
        execution_id TEXT NOT NULL,
        sequence_no INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (execution_id, sequence_no),
        FOREIGN KEY (execution_id) REFERENCES executions(execution_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS control_gates (
        execution_id TEXT NOT NULL,
        control_gate_id TEXT NOT NULL,
        gate_json TEXT NOT NULL,
        PRIMARY KEY (execution_id, control_gate_id),
        FOREIGN KEY (execution_id) REFERENCES executions(execution_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        execution_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        artifact_json TEXT NOT NULL,
        PRIMARY KEY (execution_id, artifact_id),
        FOREIGN KEY (execution_id) REFERENCES executions(execution_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS capability_outcomes (
        execution_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        outcome_json TEXT NOT NULL,
        PRIMARY KEY (execution_id, capability),
        FOREIGN KEY (execution_id) REFERENCES executions(execution_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS workspace_records (
        execution_id TEXT PRIMARY KEY,
        session_handle TEXT,
        summary_json TEXT NOT NULL,
        retained_workspace_handle TEXT,
        repo_root TEXT,
        worktree_dir TEXT,
        FOREIGN KEY (execution_id) REFERENCES executions(execution_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_executions_session_handle ON executions(session_handle);
      CREATE INDEX IF NOT EXISTS idx_sessions_latest_execution_id ON sessions(latest_execution_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_created_at_handle ON sessions(created_at, handle);
      CREATE INDEX IF NOT EXISTS idx_execution_events_execution_id ON execution_events(execution_id);
    `);
  }

  private nextSequence(executionId: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(sequence_no), 0) AS max_sequence
      FROM execution_events
      WHERE execution_id = ?
    `).get(executionId) as { max_sequence: number };
    return Number(row.max_sequence) + 1;
  }

  private appendExecutionEvents(executionId: string, startSequence: number, events: BoStaffEvent[]): void {
    const insert = this.db.prepare(`
      INSERT INTO execution_events (execution_id, sequence_no, event_json)
      VALUES (?, ?, ?)
    `);
    for (const [index, event] of events.entries()) {
      insert.run(executionId, startSequence + index, stableJson(event));
    }
  }

  private upsertSession(record: SessionRecord): void {
    this.db.prepare(`
      INSERT INTO sessions (
        handle, backend, continuity_kind, durability_kind, created_at, updated_at,
        continued_from, forked_from, provider_session_id, latest_execution_id, latest_status,
        workspace_topology, source_root, workspace_scope_mode, workspace_scope_subpath,
        continuation_capsule_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(handle) DO UPDATE SET
        backend = excluded.backend,
        continuity_kind = excluded.continuity_kind,
        durability_kind = excluded.durability_kind,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        continued_from = excluded.continued_from,
        forked_from = excluded.forked_from,
        provider_session_id = excluded.provider_session_id,
        latest_execution_id = excluded.latest_execution_id,
        latest_status = excluded.latest_status,
        workspace_topology = excluded.workspace_topology,
        source_root = excluded.source_root,
        workspace_scope_mode = excluded.workspace_scope_mode,
        workspace_scope_subpath = excluded.workspace_scope_subpath,
        continuation_capsule_json = excluded.continuation_capsule_json
    `).run(
      record.handle,
      record.backend,
      record.continuity_kind,
      record.durability_kind,
      record.created_at,
      record.updated_at,
      record.continued_from ?? null,
      record.forked_from ?? null,
      record.provider_session_id ?? null,
      record.latest_execution_id ?? null,
      record.latest_status ?? null,
      record.workspace_topology,
      record.source_root,
      record.workspace_scope_mode ?? null,
      record.workspace_scope_subpath ?? null,
      record.continuation_capsule ? stableJson(record.continuation_capsule) : null
    );
  }

  private upsertExecution(record: ExecutionRecord): void {
    this.db.prepare(`
      INSERT INTO executions (
        execution_id, request_id, session_handle, backend, status, degraded, retryable,
        started_at, updated_at, completed_at, request_snapshot_json, response_snapshot_json,
        execution_profile_json, usage_json, terminal_event_sequence, provider_session_id,
        interruption_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(execution_id) DO UPDATE SET
        request_id = excluded.request_id,
        session_handle = excluded.session_handle,
        backend = excluded.backend,
        status = excluded.status,
        degraded = excluded.degraded,
        retryable = excluded.retryable,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at,
        request_snapshot_json = excluded.request_snapshot_json,
        response_snapshot_json = excluded.response_snapshot_json,
        execution_profile_json = excluded.execution_profile_json,
        usage_json = excluded.usage_json,
        terminal_event_sequence = excluded.terminal_event_sequence,
        provider_session_id = excluded.provider_session_id,
        interruption_reason = excluded.interruption_reason
    `).run(
      record.execution_id,
      record.request_id,
      record.session_handle,
      record.backend,
      record.status,
      toSqliteBoolean(record.degraded),
      toSqliteBoolean(record.retryable),
      record.started_at,
      record.updated_at,
      record.completed_at ?? null,
      stableJson(record.request_snapshot),
      record.response_snapshot ? stableJson(record.response_snapshot) : null,
      stableJson(record.execution_profile),
      record.usage ? stableJson(record.usage) : null,
      record.terminal_event_sequence ?? null,
      record.provider_session_id ?? null,
      record.interruption_reason ?? null
    );
  }

  private replaceArtifacts(executionId: string, artifacts: ArtifactRecord[]): void {
    this.db.prepare(`DELETE FROM artifacts WHERE execution_id = ?`).run(executionId);
    const insert = this.db.prepare(`
      INSERT INTO artifacts (execution_id, artifact_id, artifact_json)
      VALUES (?, ?, ?)
    `);
    for (const artifact of artifacts) {
      insert.run(executionId, artifact.artifact_id, stableJson(artifact));
    }
  }

  private replaceControlGates(executionId: string, controlGates: ControlGateRecord[]): void {
    this.db.prepare(`DELETE FROM control_gates WHERE execution_id = ?`).run(executionId);
    const insert = this.db.prepare(`
      INSERT INTO control_gates (execution_id, control_gate_id, gate_json)
      VALUES (?, ?, ?)
    `);
    for (const gate of controlGates) {
      insert.run(executionId, gate.control_gate_id, stableJson(gate));
    }
  }

  private replaceCapabilityOutcomes(
    executionId: string,
    outcomes: Record<CapabilityName, CapabilityOutcome>
  ): void {
    this.db.prepare(`DELETE FROM capability_outcomes WHERE execution_id = ?`).run(executionId);
    const insert = this.db.prepare(`
      INSERT INTO capability_outcomes (execution_id, capability, outcome_json)
      VALUES (?, ?, ?)
    `);
    for (const [capability, outcome] of Object.entries(outcomes)) {
      insert.run(executionId, capability, stableJson(outcome));
    }
  }

  private upsertWorkspaceRecord(record: WorkspaceRecord): void {
    this.db.prepare(`
      INSERT INTO workspace_records (
        execution_id, session_handle, summary_json, retained_workspace_handle, repo_root, worktree_dir
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(execution_id) DO UPDATE SET
        session_handle = excluded.session_handle,
        summary_json = excluded.summary_json,
        retained_workspace_handle = excluded.retained_workspace_handle,
        repo_root = excluded.repo_root,
        worktree_dir = excluded.worktree_dir
    `).run(
      record.execution_id,
      record.session_handle,
      stableJson(record.summary),
      record.retained_workspace_handle ?? null,
      record.repo_root ?? null,
      record.worktree_dir ?? null
    );
  }

  private withTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("SQLite repository is closed");
    }
  }
}

interface SessionRow {
  handle: string;
  backend: string;
  continuity_kind: string;
  durability_kind: string;
  created_at: string;
  updated_at: string;
  continued_from: string | null;
  forked_from: string | null;
  provider_session_id: string | null;
  latest_execution_id: string | null;
  latest_status: string | null;
  workspace_topology: string;
  source_root: string | null;
  workspace_scope_mode: string | null;
  workspace_scope_subpath: string | null;
  continuation_capsule_json: string | null;
}

interface ExecutionRow {
  execution_id: string;
  request_id: string;
  session_handle: string | null;
  backend: string;
  status: string;
  degraded: number;
  retryable: number;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  request_snapshot_json: string;
  response_snapshot_json: string | null;
  execution_profile_json: string;
  usage_json: string | null;
  terminal_event_sequence: number | null;
  provider_session_id: string | null;
  interruption_reason: "process_crash" | "server_restart" | null;
}

interface WorkspaceRow {
  execution_id: string;
  session_handle: string | null;
  summary_json: string;
  retained_workspace_handle: string | null;
  repo_root: string | null;
  worktree_dir: string | null;
}

function mapSessionRow(row: SessionRow): SessionRecord {
  return {
    handle: row.handle,
    backend: row.backend as SessionRecord["backend"],
    continuity_kind: row.continuity_kind as SessionRecord["continuity_kind"],
    durability_kind: row.durability_kind as SessionRecord["durability_kind"],
    created_at: row.created_at,
    updated_at: row.updated_at,
    continued_from: row.continued_from ?? undefined,
    forked_from: row.forked_from ?? undefined,
    provider_session_id: row.provider_session_id ?? undefined,
    latest_execution_id: row.latest_execution_id ?? undefined,
    latest_status: row.latest_status as SessionRecord["latest_status"],
    workspace_topology: row.workspace_topology as SessionRecord["workspace_topology"],
    source_root: row.source_root,
    workspace_scope_mode: row.workspace_scope_mode as SessionRecord["workspace_scope_mode"],
    workspace_scope_subpath: row.workspace_scope_subpath ?? undefined,
    continuation_capsule: row.continuation_capsule_json
      ? parseStoredContinuationCapsule(row.continuation_capsule_json)
      : undefined
  };
}

function mapExecutionRow(row: ExecutionRow): ExecutionRecord {
  return {
    execution_id: row.execution_id,
    request_id: row.request_id,
    session_handle: row.session_handle,
    backend: row.backend as ExecutionRecord["backend"],
    status: row.status as ExecutionRecord["status"],
    degraded: fromSqliteBoolean(row.degraded),
    retryable: fromSqliteBoolean(row.retryable),
    started_at: row.started_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at ?? undefined,
    request_snapshot: JSON.parse(row.request_snapshot_json),
    response_snapshot: row.response_snapshot_json ? JSON.parse(row.response_snapshot_json) : undefined,
    execution_profile: JSON.parse(row.execution_profile_json),
    usage: row.usage_json ? JSON.parse(row.usage_json) : undefined,
    terminal_event_sequence: row.terminal_event_sequence ?? undefined,
    provider_session_id: row.provider_session_id ?? undefined,
    interruption_reason: row.interruption_reason ?? undefined
  };
}

function mapWorkspaceRow(row: WorkspaceRow): WorkspaceRecord {
  return {
    execution_id: row.execution_id,
    session_handle: row.session_handle,
    summary: JSON.parse(row.summary_json),
    retained_workspace_handle: row.retained_workspace_handle ?? undefined,
    repo_root: row.repo_root ?? undefined,
    worktree_dir: row.worktree_dir ?? undefined
  };
}

function toSqliteBoolean(value: boolean): number {
  return value ? 1 : 0;
}

function fromSqliteBoolean(value: number): boolean {
  return value === 1;
}
