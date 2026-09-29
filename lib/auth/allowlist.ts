/**
 * Parse the `RUNTIME_OWNER_GITHUB_LOGIN` allowlist — a comma- or
 * whitespace-separated list of GitHub logins — into a lowercased set. Empty
 * entries are ignored, so a blank value yields an empty set (rejects everyone).
 * A single login is still valid; the list form just admits a small shared team.
 *
 * Kept free of server-only imports so it stays unit-testable.
 */
export function parseAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(/[\s,]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== ""),
  );
}
