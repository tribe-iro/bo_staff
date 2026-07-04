export const WORKSPACE_TOPOLOGIES = ["direct"] as const;

export type WorkspaceTopology = (typeof WORKSPACE_TOPOLOGIES)[number];
export type WorkspaceScopeStatus = "enforced" | "unbounded";
