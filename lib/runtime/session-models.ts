/**
 * The models a session can be switched to, as Claude's --model takes them. No
 * imports, so it unit-tests without React or a session.
 */

export type SessionModel = { id: string; label: string };

/** A session on the user's own Claude. Aliases, so each is the newest of its
 *  family without a release here. */
export const CLAUDE_MODELS: SessionModel[] = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

/** Trim Claude's model id to a stable label — drop a trailing -YYYYMMDD date so
 *  "claude-opus-4-5-20250115" reads as "claude-opus-4-5". */
export function modelLabel(model: string): string {
  return model.replace(/-\d{8}$/, "");
}

/** Which offered model a reported one is: an exact id, or the family an alias
 *  names ("claude-opus-5" is Opus). Undefined when it is none of them. */
export function matchModel(models: SessionModel[], reported: string | undefined): SessionModel | undefined {
  if (!reported) return undefined;
  const exact = models.find((m) => m.id === reported);
  if (exact) return exact;
  const family = reported.toLowerCase().match(/^claude-(opus|sonnet|haiku)\b/)?.[1];
  return family ? models.find((m) => m.id === family) : undefined;
}
