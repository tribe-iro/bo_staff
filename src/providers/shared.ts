import type { UpstreamErrorKind } from "../errors.ts";

export function extractCliVersion(raw: string): string | null {
  const match = raw.trim().match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

export function classifyUpstreamErrorKind(output: string): UpstreamErrorKind {
  if (/rate.?limit|429|quota/i.test(output)) {
    return "rate_limit";
  }
  if (/unauthorized|invalid.*key|401|403/i.test(output)) {
    return "auth";
  }
  return "runtime";
}
