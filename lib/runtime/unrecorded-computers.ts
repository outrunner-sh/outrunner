/**
 * Runtime Computers whose row doesn't say which provider made their box
 * (`runtime_computers.provider` null: made before it was recorded, in
 * October 2026). Code reads such a row as the deployment's provider's
 * (computerMadeBy), which is wrong once the deployment moves to another: a
 * box on the old one is asked of the new, read as gone, and left running
 * unmetered. Production ran Neev, then Daytona, before it was recorded, so no
 * one provider can be assumed for them: scripts/assign-computer-providers.ts
 * asks each which has the box. /api/health counts them, for the cutover's
 * check (docs/deploy-cloudflare.md).
 */

/** How many rows naming a box don't record its provider, or "unreachable". */
export async function countUnrecordedComputers(): Promise<number | "unreachable"> {
  try {
    // Imported here: the server client needs Next's runtime, which the
    // script and the tests of providerOfBox don't have.
    const { createSupabaseAdminClient } = await import("@/lib/supabase/server");
    const { count, error } = await createSupabaseAdminClient()
      .from("runtime_computers")
      .select("id", { count: "exact", head: true })
      .is("provider", null)
      .not("daytona_sandbox_id", "is", null);
    if (error) return "unreachable";
    return count ?? 0;
  } catch {
    return "unreachable";
  }
}

/** What one provider said when asked about a box: it has it, a real
 *  not-found, or a refusal of the id (400/422), which says only that the id
 *  isn't one it takes, never that a box is gone. */
export type BoxAnswer = "yes" | "no" | "refused";

/** What a row whose box no provider has is recorded as: the provider being
 *  moved off. The box is gone, and every provider reads a box it doesn't
 *  have as gone, so this only records the row. */
export const GONE_PROVIDER = "daytona";

/**
 * The provider to record for a box, from every provider's answer: the one
 * that has it; {@link GONE_PROVIDER} only when every provider was asked
 * (`allAsked`) and each said a real not-found; otherwise null, for an
 * operator (both claim it, or one only refused: a refused box may be live,
 * and recorded as another's it would be read as gone while it billed).
 */
export function providerOfBox(answers: Record<string, BoxAnswer>, allAsked: boolean): string | null {
  const having = Object.entries(answers).filter(([, answer]) => answer === "yes").map(([name]) => name);
  if (having.length === 1) return having[0];
  if (having.length > 1) return null;
  const values = Object.values(answers);
  return allAsked && values.length > 0 && values.every((answer) => answer === "no") ? GONE_PROVIDER : null;
}
