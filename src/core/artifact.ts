export interface ArtifactRecord {
  artifact_id: string;
  kind: string;
  path?: string;
  metadata?: Record<string, unknown>;
  description?: string;
  provenance: "framework" | "backend" | "caller";
  materialization_state: "materialized" | "cataloged" | "missing";
}
