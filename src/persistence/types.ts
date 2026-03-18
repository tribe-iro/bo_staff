import type {
  ArtifactRecord,
  BackendName,
  BoStaffEvent,
  CapabilityName,
  CapabilityOutcome,
  ContinuationCapsule,
  ControlGateRecord,
  DurabilityKind,
  ExecutionResponse,
  ExecutionStatus,
  ResolvedExecutionProfile,
  UsageSummary,
  WorkspaceSummary
} from "../types.ts";

export interface StoredExecutionSnapshot {
  execution: ExecutionRecord;
  session?: SessionRecord;
  workspace: WorkspaceRecord;
  capability_outcomes: Record<CapabilityName, CapabilityOutcome>;
  artifacts: ArtifactRecord[];
  control_gates: ControlGateRecord[];
}

export interface SessionRecord {
  handle: string;
  backend: BackendName;
  continuity_kind: "native" | "managed" | "none";
  durability_kind: DurabilityKind;
  created_at: string;
  updated_at: string;
  continued_from?: string;
  forked_from?: string;
  provider_session_id?: string;
  latest_execution_id?: string;
  latest_status?: ExecutionStatus;
  workspace_topology: "direct" | "git_isolated";
  source_root: string | null;
  workspace_scope_mode?: "full" | "subpath";
  workspace_scope_subpath?: string;
  continuation_capsule?: ContinuationCapsule;
}

export interface ExecutionRecord {
  execution_id: string;
  request_id: string;
  session_handle: string | null;
  backend: BackendName;
  status: ExecutionStatus;
  degraded: boolean;
  retryable: boolean;
  started_at: string;
  updated_at: string;
  completed_at?: string;
  request_snapshot: unknown;
  response_snapshot?: ExecutionResponse;
  execution_profile: ResolvedExecutionProfile;
  usage?: UsageSummary;
  terminal_event_sequence?: number;
  provider_session_id?: string;
  interruption_reason?: "process_crash" | "server_restart";
}

export interface WorkspaceRecord {
  execution_id: string;
  session_handle: string | null;
  summary: WorkspaceSummary;
  retained_workspace_handle?: string;
  repo_root?: string;
  worktree_dir?: string;
}

export interface StoredEventRecord {
  sequence_no: number;
  event: BoStaffEvent;
}

export interface SessionPageCursor {
  created_at: string;
  handle: string;
}

export interface SessionPage {
  sessions: SessionRecord[];
  next_after?: SessionPageCursor;
}

export interface ExecutionEventPageCursor {
  sequence_no: number;
}

export interface ExecutionEventPage {
  events: BoStaffEvent[];
  next_after?: ExecutionEventPageCursor;
}

export interface StoredState {
  sessions: SessionRecord[];
  executions: ExecutionRecord[];
  execution_events: Array<StoredEventRecord & { execution_id: string }>;
  control_gates: Array<ControlGateRecord & { execution_id: string }>;
  artifacts: Array<ArtifactRecord & { execution_id: string }>;
  capability_outcomes: Array<CapabilityOutcome & { execution_id: string; capability: CapabilityName }>;
  workspace_records: WorkspaceRecord[];
}

export interface InitializeExecutionInput {
  session_record?: SessionRecord;
  execution_record: ExecutionRecord;
  capability_outcomes: Record<CapabilityName, CapabilityOutcome>;
  workspace_record: WorkspaceRecord;
}

export interface AppendExecutionEventInput {
  execution_id: string;
  event: BoStaffEvent;
  artifacts?: ArtifactRecord[];
  control_gates?: ControlGateRecord[];
}

export interface CommitTerminalExecutionInput {
  session_record?: SessionRecord;
  execution_record: ExecutionRecord;
  response_snapshot: ExecutionResponse;
  usage?: UsageSummary;
  artifacts: ArtifactRecord[];
  control_gates: ControlGateRecord[];
  capability_outcomes: Record<CapabilityName, CapabilityOutcome>;
  workspace_record: WorkspaceRecord;
  terminal_events: BoStaffEvent[];
}

export interface BoStaffRepository {
  getSession(handle: string): Promise<SessionRecord | undefined>;
  listSessionsPage(input: { limit: number; after?: SessionPageCursor }): Promise<SessionPage>;
  countSessions(): Promise<number>;
  getExecution(executionId: string): Promise<StoredExecutionSnapshot | undefined>;
  getExecutionEvents(executionId: string): Promise<BoStaffEvent[]>;
  getExecutionEventsPage(input: {
    execution_id: string;
    limit: number;
    after?: ExecutionEventPageCursor;
  }): Promise<ExecutionEventPage>;
  pruneSessionlessTerminalExecutions(before: string): Promise<number>;
  deleteSession(handle: string): Promise<boolean>;
  recoverInterruptedExecutions(): Promise<void>;
  initializeExecution(input: InitializeExecutionInput): Promise<void>;
  appendExecutionEvent(input: AppendExecutionEventInput): Promise<number>;
  commitTerminalExecution(input: CommitTerminalExecutionInput): Promise<void>;
  close(): Promise<void>;
}
