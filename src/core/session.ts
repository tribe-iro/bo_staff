export const SESSION_MODES = ["new", "continue", "fork", "ephemeral"] as const;

export type SessionMode = (typeof SESSION_MODES)[number];
export type ContinuityKind = "native" | "managed" | "none";
