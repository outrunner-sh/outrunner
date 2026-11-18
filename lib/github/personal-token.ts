/**
 * A GitHub personal access token a user pastes in Settings → Connections →
 * GitHub: what kind it is, what GitHub says about it, and what the card warns.
 * Pure, so it tests without GitHub or a database.
 *
 * A token reaches every repository its account can, without the Outrunner
 * GitHub App installed by an organization's owner. It's handed to the user's
 * cloud boxes, which run agent code, so the card steers toward a token that
 * expires and says when one never does.
 */

/** Classic (`ghp_`) or fine-grained (`github_pat_`). Other GitHub tokens
 *  (OAuth `gho_`, App `ghu_`/`ghs_`) expire or belong to an app: refused. */
export type PersonalTokenKind = "classic" | "fine_grained";

export function personalTokenKind(token: string): PersonalTokenKind | null {
  if (/^ghp_[A-Za-z0-9]+$/.test(token)) return "classic";
  if (/^github_pat_[A-Za-z0-9_]+$/.test(token)) return "fine_grained";
  return null;
}

/** A classic token's scopes, from GitHub's `X-OAuth-Scopes` header; null with
 *  no header (a fine-grained token's permissions aren't reported). */
export function parseTokenScopes(header: string | null): string[] | null {
  if (header === null) return null;
  return header
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

/**
 * When the token expires, from GitHub's `GitHub-Authentication-Token-Expiration`
 * header (`2026-12-14 10:00:00 UTC`, or with a `+0000` offset); null with no
 * header (it never expires) or one that can't be read.
 */
export function parseTokenExpiry(header: string | null): Date | null {
  const match = header?.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/);
  if (!match) return null;
  const zone = !match[3] || match[3] === "UTC" ? "Z" : match[3].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const at = new Date(`${match[1]}T${match[2]}${zone}`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** What GitHub says about a token, once it accepts it. */
export type PersonalTokenInfo = {
  githubUserId: number;
  login: string;
  kind: PersonalTokenKind;
  scopes: string[] | null;
  expiresAt: Date | null;
};

/** A token as the card shows it: nothing secret. */
export type PersonalTokenView = {
  login: string;
  kind: PersonalTokenKind;
  scopes: string[] | null;
  expiresAt: string | null;
  updatedAt: string;
};

/** Whether GitHub still takes the token, asked when Settings loads. */
export type PersonalTokenHealth = "ok" | "refused" | "unreachable";

export type PersonalTokenNote = { tone: "info" | "warning" | "error"; text: string };

/** How soon before it expires the card says so. */
const EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000;

function day(at: Date): string {
  return at.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/** What the card says about a token from what's stored, most pressing first:
 *  shown at once, while its health is still being asked. */
export function personalTokenNotes(
  token: Pick<PersonalTokenView, "login" | "kind" | "scopes" | "expiresAt">,
  now: number,
): PersonalTokenNote[] {
  const notes: PersonalTokenNote[] = [];
  const expiresAt = token.expiresAt ? new Date(token.expiresAt) : null;
  const expired = expiresAt !== null && expiresAt.getTime() <= now;
  if (expired) {
    notes.push({ tone: "error", text: `@${token.login}'s token expired on ${day(expiresAt)}. Replace it to keep working on GitHub.` });
  }
  if (token.kind === "classic" && token.scopes && !token.scopes.includes("repo")) {
    notes.push({
      tone: "warning",
      text: "This classic token doesn't have the repo scope, so it can't reach private repositories or push. Create one with repo.",
    });
  }
  if (!expired && expiresAt && expiresAt.getTime() - now <= EXPIRING_SOON_MS) {
    notes.push({ tone: "warning", text: `This token expires on ${day(expiresAt)}. Replace it before then.` });
  }
  if (!expiresAt) {
    notes.push({
      tone: "warning",
      text: "This token never expires. Your cloud sessions run agent code that can read it, so a token with an expiry date is safer.",
    });
  }
  return notes;
}

/** What the card adds once GitHub has answered (or not) whether it still
 *  takes the token; nothing when it does, or when it's already shown as
 *  expired. */
export function personalTokenHealthNote(
  token: Pick<PersonalTokenView, "login" | "expiresAt">,
  health: PersonalTokenHealth,
  now: number,
): PersonalTokenNote | null {
  if (token.expiresAt && new Date(token.expiresAt).getTime() <= now) return null;
  if (health === "refused") {
    return { tone: "error", text: `GitHub no longer accepts @${token.login}'s token. It was revoked or changed: replace it.` };
  }
  if (health === "unreachable") return { tone: "info", text: "Couldn't check the token with GitHub just now." };
  return null;
}

/** What saving a pasted token takes: tests pass their own. */
export type ConnectTokenDeps = {
  /** GitHub's word on it (inspectPersonalToken); throws to refuse it. */
  inspect(token: string): Promise<PersonalTokenInfo>;
  save(userId: string, token: string, info: PersonalTokenInfo): Promise<PersonalTokenView>;
  /** Their GitHub identity, set to their own account. */
  workAsThemselves(userId: string): Promise<void>;
};

/**
 * Save a token GitHub accepts, then make the user's sessions work as their
 * own account: as the Outrunner App, a token would be listed but never used.
 * The token is kept even when that second step fails, with
 * `identitySwitched` false for the card to say so.
 */
export async function connectPersonalToken(
  userId: string,
  token: string,
  deps: ConnectTokenDeps,
): Promise<{ token: PersonalTokenView; identitySwitched: boolean }> {
  const info = await deps.inspect(token);
  const saved = await deps.save(userId, token, info);
  try {
    await deps.workAsThemselves(userId);
    return { token: saved, identitySwitched: true };
  } catch (error) {
    console.error(`Saved user ${userId}'s GitHub token but couldn't switch their identity`, error);
    return { token: saved, identitySwitched: false };
  }
}
