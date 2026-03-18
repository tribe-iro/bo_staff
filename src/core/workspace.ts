export const WORKSPACE_TOPOLOGIES = ["direct", "git_isolated"] as const;

export type WorkspaceTopology = (typeof WORKSPACE_TOPOLOGIES)[number];
export type WorkspaceScopeStatus = "enforced" | "unbounded";
export type WorkspaceWritebackStatus = "applied" | "discarded" | "degraded" | "not_requested" | "skipped";
export type WorkspaceMaterializationStatus = "materialized" | "skipped" | "failed" | "not_requested";

export interface MaterializationPlanEntry {
  change: "add" | "modify" | "delete" | "rename" | "type_change";
  repo_relative_path: string;
  previous_repo_relative_path?: string;
  digest: string;
}
