import { BOMCP_TOOL_NAMES } from "../bomcp/types.ts";

const TOOL_SHORT_MAP: Record<string, readonly string[]> = {
  control: ["bomcp.control.handoff"],
  handoff: ["bomcp.control.handoff"],
  artifact: ["bomcp.artifact.register", "bomcp.artifact.require"],
  progress: ["bomcp.progress.update"],
};

const ALL_SHORT_NAMES = Object.keys(TOOL_SHORT_MAP);

export function expandToolNames(shortNames: string[]): { tools: string[]; errors: string[] } {
  const errors: string[] = [];
  const tools = new Set<string>();

  for (const name of shortNames) {
    if (name === "all") {
      for (const t of BOMCP_TOOL_NAMES) tools.add(t);
      continue;
    }
    if (name === "none") {
      continue;
    }
    // Already a full bomcp tool name
    if (name.startsWith("bomcp.")) {
      if ((BOMCP_TOOL_NAMES as readonly string[]).includes(name)) {
        tools.add(name);
      } else {
        errors.push(`unknown tool: ${name}`);
      }
      continue;
    }
    // Short name
    const expanded = TOOL_SHORT_MAP[name];
    if (expanded) {
      for (const t of expanded) tools.add(t);
    } else {
      errors.push(`unknown tool name: '${name}' (valid: ${ALL_SHORT_NAMES.join(", ")}, all, none)`);
    }
  }

  return { tools: [...tools], errors };
}
