export interface ArtifactRecord {
  artifact_id: string;
  kind: string;
  path?: string;
  description?: string;
  provenance: "framework" | "backend" | "caller";
  materialization_state: "materialized" | "cataloged" | "missing";
}
