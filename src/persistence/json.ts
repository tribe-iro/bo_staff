import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../utils.ts";
import { OperationQueue } from "./operation-queue.ts";
import { isTerminalStatus } from "../core/index.ts";
import type {
  ArtifactRecord,
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
  StoredState,
  WorkspaceRecord
} from "./types.ts";

export class JsonBoStaffRepository implements BoStaffRepository {
  private readonly filePath: string;
  private readonly queue = new OperationQueue();
  private stateCache?: StoredState;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "bo-staff.json");
  }

  async getSession(handle: string): Promise<SessionRecord | undefined> {
    return this.queue.enqueue(async () => {
      const state = await this.loadState();
      const session = state.sessions.find((entry) => entry.handle === handle);
      return session ? structuredClone(session) : undefined;
    });
  }

  async listSessionsPage(input: { limit: number; after?: SessionPageCursor }): Promise<SessionPage> {
    return this.queue.enqueue(async () => {
      const state = await this.loadState();
      const ordered = sortSessions(state.sessions);
      const after = input.after;
      const filtered = after
        ? ordered.filter((session) => compareSessionCursor(session, after) > 0)
        : ordered;
      const page = filtered.slice(0, input.limit);
      const nextSession = filtered.length > input.limit ? page[page.length - 1] : undefined;
      return structuredClone({
        sessions: page,
        next_after: nextSession
          ? {
            created_at: nextSession.created_at,
            handle: nextSession.handle
          }
          : undefined
      });
    });
  }

  async countSessions(): Promise<number> {
    return this.queue.enqueue(async () => {
      const state = await this.loadState();
      return state.sessions.length;
    });
  }

  async getExecution(executionId: string) {
    return this.queue.enqueue(async () => {
      const state = await this.loadState();
      const execution = state.executions.find((entry) => entry.execution_id === executionId);
      if (!execution) {
        return undefined;
      }
      const session = execution.session_handle
        ? state.sessions.find((entry) => entry.handle === execution.session_handle)
        : undefined;
      const workspace = state.workspace_records.find((entry) => entry.execution_id === executionId);
      if (!workspace) {
        return undefined;
      }
      return structuredClone({
        execution,
        session,
        workspace,
        capability_outcomes: Object.fromEntries(
          state.capability_outcomes
            .filter((entry) => entry.execution_id === executionId)
            .map((entry) => [entry.capability, stripExecutionId(entry)])
        ) as unknown as import("./types.ts").StoredExecutionSnapshot["capability_outcomes"],
        artifacts: state.artifacts
          .filter((entry) => entry.execution_id === executionId)
          .map((entry) => stripExecutionId(entry) as ArtifactRecord),
        control_gates: state.control_gates
          .filter((entry) => entry.execution_id === executionId)
          .map((entry) => stripExecutionId(entry) as ControlGateRecord)
      });
    });
  }

  async getExecutionEvents(executionId: string): Promise<import("../types.ts").BoStaffEvent[]> {
    return this.queue.enqueue(async () => {
      const state = await this.loadState();
      return structuredClone(
        state.execution_events
          .filter((entry) => entry.execution_id === executionId)
          .sort((left, right) => left.sequence_no - right.sequence_no)
          .map((entry) => entry.event)
      );
    });
  }

  async getExecutionEventsPage(input: {
    execution_id: string;
    limit: number;
    after?: ExecutionEventPageCursor;
  }): Promise<ExecutionEventPage> {
    return this.queue.enqueue(async () => {
      const ordered = (await this.loadState()).execution_events
        .filter((entry) => entry.execution_id === input.execution_id)
        .sort((left, right) => left.sequence_no - right.sequence_no);
      const filtered = input.after
        ? ordered.filter((entry) => entry.sequence_no > input.after!.sequence_no)
        : ordered;
      const page = filtered.slice(0, input.limit);
      const nextEntry = filtered.length > input.limit ? page[page.length - 1] : undefined;
      return structuredClone({
        events: page.map((entry) => entry.event),
        next_after: nextEntry
          ? {
            sequence_no: nextEntry.sequence_no
          }
          : undefined
      });
    });
  }

  async deleteSession(handle: string): Promise<boolean> {
    return this.queue.enqueue(async () => {
      const state = await this.loadState();
      const before = state.sessions.length;
      state.sessions = state.sessions.filter((entry) => entry.handle !== handle);
      if (state.sessions.length === before) {
        return false;
      }
      const executionIds = new Set(state.executions
        .filter((entry) => entry.session_handle === handle)
        .map((entry) => entry.execution_id));
      state.executions = state.executions.filter((entry) => entry.session_handle !== handle);
      state.execution_events = state.execution_events.filter((entry) => !executionIds.has(entry.execution_id));
      state.control_gates = state.control_gates.filter((entry) => !executionIds.has(entry.execution_id));
      state.artifacts = state.artifacts.filter((entry) => !executionIds.has(entry.execution_id));
      state.capability_outcomes = state.capability_outcomes.filter((entry) => !executionIds.has(entry.execution_id));
      state.workspace_records = state.workspace_records.filter((entry) => entry.session_handle !== handle);
      await this.saveState(state);
      return true;
    });
  }

  async pruneSessionlessTerminalExecutions(before: string): Promise<number> {
    return this.queue.enqueue(async () => {
      const state = await this.loadState();
      const removableExecutionIds = new Set(state.executions
        .filter((execution) =>
          execution.session_handle === null
          && execution.completed_at !== undefined
          && execution.completed_at < before)
        .map((execution) => execution.execution_id));
      if (removableExecutionIds.size === 0) {
        return 0;
      }
      state.executions = state.executions.filter((entry) => !removableExecutionIds.has(entry.execution_id));
      state.execution_events = state.execution_events.filter((entry) => !removableExecutionIds.has(entry.execution_id));
      state.control_gates = state.control_gates.filter((entry) => !removableExecutionIds.has(entry.execution_id));
      state.artifacts = state.artifacts.filter((entry) => !removableExecutionIds.has(entry.execution_id));
      state.capability_outcomes = state.capability_outcomes.filter((entry) => !removableExecutionIds.has(entry.execution_id));
      state.workspace_records = state.workspace_records.filter((entry) => !removableExecutionIds.has(entry.execution_id));
      await this.saveState(state);
      return removableExecutionIds.size;
    });
  }

  async recoverInterruptedExecutions(): Promise<void> {
    await this.queue.enqueue(async () => {
      const state = await this.loadState();
      let changed = false;
      for (const execution of state.executions) {
        if (execution.completed_at || isTerminalStatus(execution.status)) {
          continue;
        }
        execution.status = "failed";
        execution.retryable = true;
        execution.interruption_reason = "server_restart";
        execution.completed_at = execution.updated_at;
        changed = true;
      }
      if (changed) {
        await this.saveState(state);
      }
    });
  }

  async initializeExecution(input: InitializeExecutionInput): Promise<void> {
    await this.queue.enqueue(async () => {
      const state = await this.loadState();
      if (input.session_record) {
        upsertSession(state, input.session_record);
      }
      upsertExecution(state, input.execution_record);
      replaceCapabilityOutcomes(state, input.execution_record.execution_id, input.capability_outcomes);
      upsertWorkspaceRecord(state, input.workspace_record);
      await this.saveState(state);
    });
  }

  async appendExecutionEvent(input: AppendExecutionEventInput): Promise<number> {
    return this.queue.enqueue(async () => {
      const state = await this.loadState();
      const nextSequence = state.execution_events
        .filter((entry) => entry.execution_id === input.execution_id)
        .reduce((max, entry) => Math.max(max, entry.sequence_no), 0) + 1;
      state.execution_events.push({
        execution_id: input.execution_id,
        sequence_no: nextSequence,
        event: input.event
      });
      if (input.artifacts) {
        replaceArtifacts(state, input.execution_id, input.artifacts);
      }
      if (input.control_gates) {
        replaceControlGates(state, input.execution_id, input.control_gates);
      }
      await this.saveState(state);
      return nextSequence;
    });
  }

  async commitTerminalExecution(input: CommitTerminalExecutionInput): Promise<void> {
    await this.queue.enqueue(async () => {
      const state = await this.loadState();
      const firstSequence = state.execution_events
        .filter((entry) => entry.execution_id === input.execution_record.execution_id)
        .reduce((max, entry) => Math.max(max, entry.sequence_no), 0) + 1;
      const terminalEventSequence = firstSequence + input.terminal_events.length - 1;
      if (input.session_record) {
        upsertSession(state, input.session_record);
      }
      upsertExecution(state, {
        ...input.execution_record,
        response_snapshot: input.response_snapshot,
        usage: input.usage,
        terminal_event_sequence: terminalEventSequence
      });
      input.terminal_events.forEach((event, index) => {
        state.execution_events.push({
          execution_id: input.execution_record.execution_id,
          sequence_no: firstSequence + index,
          event
        });
      });
      replaceArtifacts(state, input.execution_record.execution_id, input.artifacts);
      replaceControlGates(state, input.execution_record.execution_id, input.control_gates);
      replaceCapabilityOutcomes(state, input.execution_record.execution_id, input.capability_outcomes);
      upsertWorkspaceRecord(state, input.workspace_record);
      await this.saveState(state);
    });
  }

  async close(): Promise<void> {
    this.stateCache = undefined;
  }

  private async loadState(): Promise<StoredState> {
    if (!this.stateCache) {
      this.stateCache = await readJsonFile(this.filePath, createEmptyState());
    }
    return this.stateCache;
  }

  private async saveState(state: StoredState): Promise<void> {
    await writeJsonFileAtomic(this.filePath, state);
    this.stateCache = state;
  }
}

function createEmptyState(): StoredState {
  return {
    sessions: [],
    executions: [],
    execution_events: [],
    control_gates: [],
    artifacts: [],
    capability_outcomes: [],
    workspace_records: []
  };
}

function upsertSession(state: StoredState, record: SessionRecord): void {
  state.sessions = state.sessions.filter((entry) => entry.handle !== record.handle);
  state.sessions.push(record);
}

function upsertExecution(state: StoredState, record: ExecutionRecord): void {
  state.executions = state.executions.filter((entry) => entry.execution_id !== record.execution_id);
  state.executions.push(record);
}

function replaceControlGates(state: StoredState, executionId: string, records: ControlGateRecord[]): void {
  state.control_gates = state.control_gates.filter((entry) => entry.execution_id !== executionId);
  state.control_gates.push(...records.map((record) => ({ ...record, execution_id: executionId })));
}

function replaceArtifacts(state: StoredState, executionId: string, records: ArtifactRecord[]): void {
  state.artifacts = state.artifacts.filter((entry) => entry.execution_id !== executionId);
  state.artifacts.push(...records.map((record) => ({ ...record, execution_id: executionId })));
}

function replaceCapabilityOutcomes(
  state: StoredState,
  executionId: string,
  outcomes: Record<CapabilityName, CapabilityOutcome>
): void {
  state.capability_outcomes = state.capability_outcomes.filter((entry) => entry.execution_id !== executionId);
  state.capability_outcomes.push(...Object.entries(outcomes).map(([capability, outcome]) => ({
    ...outcome,
    capability: capability as CapabilityName,
    execution_id: executionId
  })));
}

function upsertWorkspaceRecord(state: StoredState, record: WorkspaceRecord): void {
  state.workspace_records = state.workspace_records.filter((entry) => entry.execution_id !== record.execution_id);
  state.workspace_records.push(record);
}

function stripExecutionId<T extends { execution_id: string }>(record: T): Omit<T, "execution_id"> {
  const { execution_id: _executionId, ...rest } = record;
  return rest;
}

function sortSessions(sessions: SessionRecord[]): SessionRecord[] {
  return sessions
    .slice()
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.handle.localeCompare(right.handle));
}

function compareSessionCursor(session: SessionRecord, cursor: SessionPageCursor): number {
  return session.created_at.localeCompare(cursor.created_at) || session.handle.localeCompare(cursor.handle);
}
