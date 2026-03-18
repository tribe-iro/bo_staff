export function extractJsonObject(raw: string): unknown {
  const normalized = extractJsonObjectText(raw);
  if (!normalized) {
    throw new Error("Missing JSON output");
  }

  const parsed = JSON.parse(normalized);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON output must be an object");
  }
  return parsed;
}

export function extractJsonObjectText(raw: string): string {
  return stripSingleCodeFence(raw).trim();
}

export function extractSingleEmbeddedFencedJsonObjectText(raw: string): string | undefined {
  const matches = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)];
  if (matches.length !== 1) {
    return undefined;
  }
  try {
    return parseSingleEmbeddedFencedJsonObjectText(raw);
  } catch {
    return undefined;
  }
}

export function parseSingleEmbeddedFencedJsonObjectText(raw: string): string {
  const matches = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)];
  if (matches.length !== 1) {
    throw new Error("Expected exactly one fenced JSON object");
  }
  const candidate = matches[0]?.[1]?.trim() ?? "";
  if (!candidate) {
    throw new Error("Missing fenced JSON object");
  }

  const parsed = JSON.parse(candidate);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON output must be an object");
  }
  return candidate;
}

function stripSingleCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
}
