import {
  GitHubReconnectError,
  GitHubSyncError,
  MissingGithubTokenError,
} from "@/lib/github/client";

/**
 * What a route answers when GitHub work fails, or null for an error that is not
 * GitHub's (the caller logs it and answers its own 500).
 *
 * `reconnect: true` marks the failures only a fresh sign-in fixes — no stored
 * token, or one GitHub now refuses — so the UI can link to Settings → Account
 * instead of offering a retry that cannot succeed.
 *
 * A plain `Response` (not NextResponse) so it stays importable outside Next.
 */
export function githubErrorResponse(error: unknown): Response | null {
  if (error instanceof MissingGithubTokenError) {
    return Response.json({ error: error.message, reconnect: true }, { status: 409 });
  }
  if (error instanceof GitHubReconnectError) {
    return Response.json({ error: error.message, reconnect: true }, { status: 502 });
  }
  if (error instanceof GitHubSyncError) {
    return Response.json({ error: error.message }, { status: 502 });
  }
  return null;
}
