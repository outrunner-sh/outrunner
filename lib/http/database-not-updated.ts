import { probeStatus } from "@/lib/supabase/probe";

/**
 * The answer to a save the database refused because a migration isn't applied
 * yet (its table or columns aren't there): that is the database's to fix, not
 * the user's, so it says so rather than "try again". Null for any other error.
 * A plain Response, which route handlers return as they do NextResponse.
 */
export function databaseNotUpdated(error: unknown, what: string): Response | null {
  const status = probeStatus(error as { code?: string });
  if (status !== "outdated" && status !== "missing") return null;
  console.error(`Could not save ${what}: the database is missing a migration`, error);
  return Response.json(
    { error: "This can't be saved until Outrunner's database is updated. Try again later." },
    { status: 503 },
  );
}
