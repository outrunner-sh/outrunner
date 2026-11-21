/**
 * A Claude account's name (lib/claude/accounts.ts), checked the same way in
 * the browser, as it's typed, and on the server. Imports nothing, so the
 * Settings page can use it.
 */

export const MAX_LABEL = 32;

/** The label, trimmed, or what's wrong with it, for the person to read. */
export function checkLabel(raw: unknown): { label: string } | { error: string } {
  const label = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!label) return { error: "Give the account a name, like work or personal." };
  if (label.length > MAX_LABEL) return { error: `Keep the name to ${MAX_LABEL} characters.` };
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(label)) {
    return { error: "Use letters, numbers, spaces, dots, dashes or underscores in the name." };
  }
  return { label };
}
