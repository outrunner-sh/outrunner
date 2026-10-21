/**
 * The answer to a failure to create a session's row. The index that keeps one
 * live session per branch answers Postgres' unique_violation: a conflict the
 * user can fix, not a server failure. Anything else stays in the log under
 * `context`.
 * A plain Response, which route handlers return as they do NextResponse, so
 * it tests without Next.
 */
export function workspaceCreateErrorResponse(error: unknown, context: string): Response {
  if (error && typeof error === "object" && "code" in error && error.code === "23505") {
    return Response.json(
      {
        error:
          "Another session is already working on that branch. Pick another branch, or open that session from the sidebar.",
      },
      { status: 409 },
    );
  }
  console.error(context, error);
  return Response.json({ error: "Couldn't create the session. Try again in a moment." }, { status: 500 });
}
