import type { ValidationIssue } from "../types.ts";

export function formatValidationIssueSummary(issues: ValidationIssue[]): string {
  return issues
    .map((issue) => `${issue.path} ${issue.message}`)
    .join("; ");
}
