import { GitHubReconnectError, GitHubSyncError, MissingGithubTokenError } from "@/lib/github/client";
import { GitIdentityError } from "@/lib/github/identity-error";

/** Where Reconnect GitHub (minting a fresh GitHub token) lives. */
export const GITHUB_RECONNECT_HREF = "/settings/account";

/**
 * The response for an error from a route's GitHub work: no usable token is
 * 409, GitHub refusing or failing is 502 with its already-safe message, and
 * anything else is logged and becomes 500 with `fallback`.
 *
 * `reconnect: true` marks the failures only a fresh GitHub token fixes — no
 * stored token, or one GitHub now refuses — so the UI can offer Reconnect
 * GitHub instead of a retry that cannot succeed. A user who chose the
 * Outrunner App, with no way to it for the repository, is 409 too, with
 * `settingsHref` where that's put right (lib/github/identity.ts).
 *
 * A plain `Response` (not NextResponse) so it stays importable outside Next.
 */
export function githubErrorResponse(error: unknown, fallback: string): Response {
  if (error instanceof GitIdentityError) {
    return Response.json({ error: error.message, settingsHref: error.href }, { status: 409 });
  }
  if (error instanceof MissingGithubTokenError) {
    return Response.json({ error: error.message, reconnect: true }, { status: 409 });
  }
  if (error instanceof GitHubReconnectError) {
    return Response.json({ error: error.message, reconnect: true }, { status: 502 });
  }
  if (error instanceof GitHubSyncError) {
    return Response.json({ error: error.message }, { status: 502 });
  }
  console.error(fallback, error);
  return Response.json({ error: fallback }, { status: 500 });
}
