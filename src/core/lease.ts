export interface ExecutionLease {
  execution_id: string;
  allowed_tools: readonly string[];
  timeout_seconds?: number;
  issued_at: string;
  expires_at?: string;
}
