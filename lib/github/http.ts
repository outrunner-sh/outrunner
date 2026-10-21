import { GitHubReconnectError, GitHubSyncError, MissingGithubTokenError } from "@/lib/github/client";

/**
 * The response for an error from a route's GitHub work: no usable token is
 * 409, GitHub refusing or failing is 502 with its already-safe message, and
 * anything else is logged and becomes 500 with `fallback`.
 *
 * `reconnect: true` marks the failures only a fresh sign-in fixes — no stored
 * token, or one GitHub now refuses — so the UI can link to Settings → Account
 * instead of offering a retry that cannot succeed.
 *
 * A plain `Response` (not NextResponse) so it stays importable outside Next.
 */
export function githubErrorResponse(error: unknown, fallback: string): Response {
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
