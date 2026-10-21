import { NextResponse } from "next/server";

import { GitHubSyncError } from "@/lib/github/client";
import { MissingGithubTokenError } from "@/lib/github/token";

/**
 * The response for an error from a route's GitHub work: no usable token is
 * 409 (the user reconnects by signing in again), GitHub refusing or failing
 * is 502 with its already-safe message, and anything else is logged and
 * becomes 500 with `fallback`.
 */
export function githubErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof MissingGithubTokenError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof GitHubSyncError) {
    return NextResponse.json({ error: error.message }, { status: 502 });
  }
  console.error(fallback, error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}
