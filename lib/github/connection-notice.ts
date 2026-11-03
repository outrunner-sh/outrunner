/**
 * Whether to ask the user, wherever they are in the app, to connect GitHub in
 * Settings → Connections: their work runs on an old sign-in token (`legacy`,
 * lib/github/legacy-token.ts), or GitHub stopped renewing their connection
 * (`broken`). Never throws: the frame shows nothing when it can't be read.
 */

import { hasGithubToken } from "@/lib/db/credentials";
import { githubConnectionStatus } from "@/lib/db/github-connections";
import { legacyTokenMode } from "@/lib/github/legacy-token";
import { userAuthConfigured } from "@/lib/github/user-connection.deps";

export type GitHubConnectionNotice = "legacy" | "broken" | null;

export async function githubConnectionNotice(userId: string): Promise<GitHubConnectionNotice> {
  if (!userAuthConfigured()) return null;
  try {
    const [status, legacy] = await Promise.all([githubConnectionStatus(userId), hasGithubToken(userId)]);
    if (status) return status.broken ? "broken" : null;
    return legacy && legacyTokenMode() === "fallback" ? "legacy" : null;
  } catch (error) {
    console.error(`Could not read user ${userId}'s GitHub connection for its notice`, error);
    return null;
  }
}
