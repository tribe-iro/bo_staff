/** A missing optional file is normal; every other filesystem error should reach the caller. */
export function isMissingFile(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}
