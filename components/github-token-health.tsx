import { InlineMessage } from "@/components/ui/notice";
import { githubTokenSecret } from "@/lib/db/github-tokens";
import { tokenOwner, type TokenOwner } from "@/lib/github/client";
import {
  personalTokenHealthNote,
  type PersonalTokenHealth,
  type PersonalTokenNote,
  type PersonalTokenView,
} from "@/lib/github/personal-token";

/** How long Settings waits on GitHub before saying it couldn't check. */
const CHECK_TIMEOUT_MS = 3000;

/**
 * Whether GitHub still takes the user's personal access token, streamed into
 * its card (components/github-token-card.tsx) so the page never waits on
 * GitHub: nothing when it does.
 */
export async function GitHubTokenHealth({ userId, token }: { userId: string; token: PersonalTokenView }) {
  const note = await healthNote(userId, token);
  return note ? <InlineMessage tone={note.tone}>{note.text}</InlineMessage> : null;
}

async function healthNote(userId: string, token: PersonalTokenView): Promise<PersonalTokenNote | null> {
  let health: PersonalTokenHealth;
  try {
    const secret = await githubTokenSecret(userId);
    if (!secret) return { tone: "error", text: "Outrunner can no longer read this token. Replace it." };
    health = toHealth(await withTimeout(tokenOwner(secret.token)));
  } catch (error) {
    console.warn("Settings: couldn't check the GitHub token", error instanceof Error ? error.message : error);
    health = "unreachable";
  }
  return personalTokenHealthNote(token, health, Date.now());
}

function toHealth(owner: TokenOwner): PersonalTokenHealth {
  return owner.kind === "user" ? "ok" : owner.kind;
}

async function withTimeout(check: Promise<TokenOwner>): Promise<TokenOwner> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TokenOwner>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "unreachable" }), CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([check, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
