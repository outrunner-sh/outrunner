/** Postgres' unique_violation, which here is the live-branch index: another
 * session already holds the branch. */
export function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

/** The answer when another session holds the requested branch: that session's
 * name, and its page, so the user can go to it rather than only being told
 * that one exists. */
export function branchTakenResponse(holder: { id: string; label: string }): Response {
  return Response.json(
    {
      error: `“${holder.label}” is already working on that branch. Open that session, or pick another branch.`,
      sessionHref: `/workspaces/${holder.id}`,
    },
    { status: 409 },
  );
}

/** A requested branch another member's session in the org works on: theirs
 *  isn't the user's to open (sessions are each member's own), so only say so. */
export function branchTakenByTeammateResponse(): Response {
  return Response.json(
    { error: "Another member's session is working on that branch. Pick another branch." },
    { status: 409 },
  );
}

/**
 * The answer to a failure to create a session's row. The index that keeps one
 * live session per branch answers Postgres' unique_violation: a conflict the
 * user can fix, not a server failure. Anything else stays in the log under
 * `context`.
 * A plain Response, which route handlers return as they do NextResponse, so
 * it tests without Next.
 */
export function workspaceCreateErrorResponse(error: unknown, context: string): Response {
  if (isUniqueViolation(error)) {
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
